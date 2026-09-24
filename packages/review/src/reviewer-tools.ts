// The reviewer's tools (Stage 2). Reads are served by the orchestrator over the
// head checkout as data, jailed to it; the one tool that executes anything,
// `run_command`, is brokered into the execution cell and gated by the run's
// permission profile. Candidate findings come back through `report_finding`
// as structured objects, never as prose to parse.
import { readdir, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import type { LLMTool } from '@copse/llm/wire-types.ts'
import type { HeadlessPermissionDecision } from '@copse/agent/headless-contract.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { readFileDiff, type ReviewContext } from './context.ts'
import { jailPath, readCheckoutFile } from './checkout-fs.ts'
export { jailPath } from './checkout-fs.ts'
import { readDependencyFileInCell } from './dependency-reader.ts'
import { FINDING_CLASSES, FINDING_CONFIDENCES, FINDING_SEVERITIES } from './finding.ts'
import type { CellCommandResult, ExecutionCell } from './isolation.ts'

export const REVIEWER_TOOL_NAMES = [
  'read_file',
  'read_dependency_file',
  'list_dir',
  'search_code',
  'git_diff',
  'run_command',
  'record_suspicion',
  'report_finding',
  'finish_review',
] as const
export type ReviewerToolName = (typeof REVIEWER_TOOL_NAMES)[number]

/** Characters of tool output the model gets to see per call. */
export const MAX_TOOL_OUTPUT_CHARS = 16_000
const MAX_SEARCH_HITS = 60
const MAX_SEARCH_FILE_BYTES = 512 * 1024
const RUN_COMMAND_MAX_TIMEOUT_MS = 5 * 60 * 1000
const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-test', 'coverage', '.pnpm'])

/** What the model reports; turned into a `Finding` by Stage 5 once anchored to the source. */
export const candidateFindingSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  class: z.enum(FINDING_CLASSES),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.enum(FINDING_CONFIDENCES),
  /** One sentence, falsifiable. */
  claim: z.string().min(8).max(400),
  /** Why the anchored lines are wrong: the specific reasoning, not a restatement. */
  reason: z.string().min(8).max(1_200),
  /** Tool-call ids of `run_command` calls whose output demonstrates the defect. */
  commandCallIds: z.array(z.string().min(1)).max(4).optional(),
})
export type CandidateFinding = z.infer<typeof candidateFindingSchema>

export const reviewCompletionSchema = z.object({
  /** A concise account of the files, callers, tests, or boundaries actually inspected. */
  checked: z.string().trim().min(8).max(800),
  /** Anything material the reviewer could not settle; use "Nothing" when there was none. */
  couldNotVerify: z.string().trim().min(2).max(800),
})
export type ReviewCompletion = z.infer<typeof reviewCompletionSchema>

const suspicionSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  claim: z.string().trim().min(8).max(400),
})

const dispositionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['reported', 'refuted', 'unresolved']),
  evidence: z.string().trim().min(8).max(400),
  findingIndex: z.number().int().positive().optional(),
})

type Suspicion = z.infer<typeof suspicionSchema> & { readonly id: string }

const reviewClosureSchema = reviewCompletionSchema.extend({
  dispositions: z.array(dispositionSchema).max(20).optional().default([]),
  /** Findings not already emitted through report_finding, carried by the final attestation. */
  findings: z.array(candidateFindingSchema).max(20).optional().default([]),
})

export interface ReportedCandidate {
  readonly candidate: CandidateFinding
  /** The source lines the candidate is anchored to, read at report time. */
  readonly anchoredText: string
  readonly toolCallId: string
}

export interface ReviewerToolHost {
  readonly headCheckout: string
  readonly context: ReviewContext
  /** The cell to run commands in; `null` when execution was refused. */
  readonly cell: ExecutionCell | null
  /** The run's resolved shell decision; `run_command` refuses unless `allow`. */
  readonly shellDecision: HeadlessPermissionDecision
  /** Redacts host secrets from anything that came out of the cell. */
  scrub(text: string): string
}

function candidateFindingParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      class: { type: 'string', enum: [...FINDING_CLASSES] },
      severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
      confidence: { type: 'string', enum: [...FINDING_CONFIDENCES] },
      claim: {
        type: 'string',
        minLength: 8,
        maxLength: 400,
        description: 'One sentence, falsifiable',
      },
      reason: {
        type: 'string',
        minLength: 8,
        maxLength: 1_200,
        description: 'Why these lines are wrong',
      },
      commandCallIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 4,
        description:
          'Copy commandCallId from each run_command result whose output demonstrates the defect; do not use the tool name',
      },
    },
    required: ['path', 'startLine', 'class', 'severity', 'confidence', 'claim', 'reason'],
  }
}

function finishReviewTool(requireFindings: boolean): LLMTool {
  return {
    name: 'finish_review',
    description:
      'Required final tool call. Attest what you actually checked and what you could not verify. Include every defect not already sent through report_finding in findings. Call exactly once, after all other tools; a review without it is incomplete.',
    parameters: {
      type: 'object',
      properties: {
        dispositions: {
          type: 'array',
          maxItems: 20,
          description:
            'Resolve every record_suspicion id exactly once. For reported, give the 1-based findingIndex across earlier report_finding calls followed by findings in this closure. For refuted, cite the concrete counterevidence. For unresolved, include its id in couldNotVerify.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['reported', 'refuted', 'unresolved'] },
              evidence: { type: 'string', minLength: 8, maxLength: 400 },
              findingIndex: { type: 'integer', minimum: 1 },
            },
            required: ['id', 'status', 'evidence'],
          },
        },
        checked: {
          type: 'string',
          minLength: 8,
          maxLength: 800,
          description: 'Concise account of the files, callers, tests, or boundaries inspected',
        },
        couldNotVerify: {
          type: 'string',
          minLength: 2,
          maxLength: 800,
          description: 'Material uncertainty or unverified work; use "Nothing" when there was none',
        },
        findings: {
          type: 'array',
          items: candidateFindingParameters(),
          maxItems: 20,
          description:
            'Every concrete defect from the review that was not already emitted through report_finding; [] for a clean review',
        },
      },
      required: requireFindings
        ? ['checked', 'couldNotVerify', 'findings']
        : ['checked', 'couldNotVerify'],
    },
  }
}

export function reviewerTools(): LLMTool[] {
  return [
    {
      name: 'read_file',
      description:
        'Read a file from the change under review. Returns numbered lines; pass startLine/endLine to read a window.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path' },
          startLine: { type: 'integer', description: 'First line to return (1-based)' },
          endLine: { type: 'integer', description: 'Last line to return (inclusive)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_dependency_file',
      description:
        'Read an installed package source file through the isolated execution cell. Use this instead of read_file when pnpm package symlinks are refused. Pass a package-relative path such as jsdom/lib/api.js; a leading node_modules/ is also accepted. This reads data only and never executes package code.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Package-relative path, e.g. jsdom/lib/api.js (optional node_modules/ prefix)',
          },
          startLine: { type: 'integer', description: 'First line to return (1-based)' },
          endLine: { type: 'integer', description: 'Last line to return (inclusive)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory of the change under review.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative directory; default is the root' },
        },
        required: [],
      },
    },
    {
      name: 'search_code',
      description:
        'Search file contents with a regular expression (JavaScript syntax). Returns path:line: text for each hit.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression; treated literally if it does not parse',
          },
          path: {
            type: 'string',
            description: 'Repo-relative directory or file to search; default is the root',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'git_diff',
      description:
        'Read the original diff of one changed file against the merge-base, including omitted/deleted files. Large diffs are paged; pass the returned nextOffset to continue.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A changed file' },
          offset: { type: 'integer', description: 'Zero-based character offset; default 0' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_command',
      description:
        'Run a program in an isolated copy of the change (no shell: pass argv as an actual array, not a quoted JSON string). Prefer a focused test selector or small probe that settles one question; Stage 0 already ran the aggregate project checks. Output is capped. The result includes commandCallId to copy into a finding’s commandCallIds evidence references.',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            description: 'Program and arguments, e.g. ["pnpm", "test", "--", "thread-store"]',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Optional timeout in milliseconds (max 300000)',
          },
        },
        required: ['argv'],
      },
    },
    {
      name: 'record_suspicion',
      description:
        'Preserve a concrete suspected defect before investigating it. Returns an immutable id that finish_review must resolve as reported, refuted with counterevidence, or unresolved. This is not a finding.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1 },
          startLine: { type: 'integer', minimum: 1 },
          claim: { type: 'string', minLength: 8, maxLength: 400 },
        },
        required: ['path', 'startLine', 'claim'],
      },
    },
    {
      name: 'report_finding',
      description:
        'Report one defect in the change. Anchor it at the exact lines; give a falsifiable one-sentence claim and the specific reason.',
      parameters: candidateFindingParameters(),
    },
    finishReviewTool(false),
  ]
}

/** A one-tool protocol-repair surface for a reviewer that ended in prose. */
export function reviewerClosureTools(): LLMTool[] {
  return [finishReviewTool(true)]
}

const readFileArgs = decodeWithSchema(
  z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
)
const listDirArgs = decodeWithSchema(z.object({ path: z.string().optional() }))
const searchArgs = decodeWithSchema(
  z.object({ pattern: z.string().min(1), path: z.string().optional() }),
)
const gitDiffArgs = decodeWithSchema(
  z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().optional() }),
)
const commandArgvSchema = z.array(z.string().min(1)).min(1)
const runCommandArgsSchema = z.object({
  argv: commandArgvSchema,
  timeoutMs: z.number().int().positive().max(RUN_COMMAND_MAX_TIMEOUT_MS).optional(),
})
const decodeRunCommandArgs = decodeWithSchema(runCommandArgsSchema)
const decodeEncodedRunCommandArgs = decodeWithSchema(
  z.object({
    argv: z.string().min(1),
    timeoutMs: z.number().int().positive().max(RUN_COMMAND_MAX_TIMEOUT_MS).optional(),
  }),
)
const decodeCommandArgv = decodeWithSchema(commandArgvSchema)

/**
 * Some OpenAI-compatible models double-encode argv but leave literal newlines
 * inside the nested JSON string. Repair only JSON-forbidden control characters
 * inside quoted strings; the result still has to decode as `string[]` below.
 */
function escapeJsonStringControlCharacters(text: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (const character of text) {
    if (!inString) {
      result += character
      if (character === '"') inString = true
      continue
    }
    if (escaped) {
      result += character
      escaped = false
      continue
    }
    if (character === '\\') {
      result += character
      escaped = true
      continue
    }
    if (character === '"') {
      result += character
      inString = false
      continue
    }
    const codePoint = character.codePointAt(0)
    result +=
      codePoint !== undefined && codePoint <= 0x1f
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : character
  }
  return result
}

/** Tolerate the JSON-encoded argv some OpenAI-compatible models emit. */
function runCommandArgs(args: unknown): z.infer<typeof runCommandArgsSchema> | null {
  const direct = decodeRunCommandArgs(args)
  if (direct !== null) return direct
  const encoded = decodeEncodedRunCommandArgs(args)
  if (encoded === null) return null
  const argv =
    safeJsonParse(encoded.argv, decodeCommandArgv) ??
    safeJsonParse(escapeJsonStringControlCharacters(encoded.argv), decodeCommandArgv)
  if (argv === null) return null
  return encoded.timeoutMs === undefined ? { argv } : { argv, timeoutMs: encoded.timeoutMs }
}
const decodeCandidate = decodeWithSchema(candidateFindingSchema)
class ToolInputError extends Error {}

function describeClosureValidation(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
}

function cap(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…(output truncated at ${String(MAX_TOOL_OUTPUT_CHARS)} characters)`
}

function toRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: string[]
  try {
    entries = (await readdir(dir)).sort()
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue
    const path = join(dir, entry)
    let info
    try {
      info = await lstat(path)
    } catch {
      continue
    }
    if (info.isDirectory()) yield* walkFiles(path)
    else if (info.isFile() && info.size <= MAX_SEARCH_FILE_BYTES) yield path
  }
}

export interface ReviewerToolExecutor {
  execute(name: string, args: unknown, signal: AbortSignal, toolCallId: string): Promise<string>
  /** Every candidate the model reported, in order. */
  reported(): readonly ReportedCandidate[]
  /** The model's explicit clean-or-findings completion attestation. */
  completion(): ReviewCompletion | null
  /** Why the last finish_review call was rejected. */
  completionError(): string | null
  /** Immutable hypotheses, retained through budget exhaustion and closure repair. */
  suspicions(): readonly Suspicion[]
  /** Every `run_command` result, by tool-call id, for evidence. */
  commandRuns(): ReadonlyMap<string, CellCommandResult>
}

export function createReviewerToolExecutor(host: ReviewerToolHost): ReviewerToolExecutor {
  const reported: ReportedCandidate[] = []
  const suspicions: Suspicion[] = []
  const commandRuns = new Map<string, CellCommandResult>()
  let completion: ReviewCompletion | null = null
  let completionError: string | null = null
  const root = jailPath(host.headCheckout, '.')

  function readSource(path: string): Promise<string> {
    try {
      return Promise.resolve(readCheckoutFile(root, path))
    } catch (err) {
      const dependencyHint = path.replaceAll('\\', '/').startsWith('node_modules/')
        ? '; use read_dependency_file for installed package source'
        : ''
      return Promise.reject(
        new ToolInputError(`Cannot read ${path}: ${errorMessage(err)}${dependencyHint}`),
      )
    }
  }

  async function prepareCandidate(
    candidate: CandidateFinding,
    toolCallId: string,
  ): Promise<ReportedCandidate> {
    const lines = (await readSource(candidate.path)).split(/\r?\n/)
    const end = candidate.endLine ?? candidate.startLine
    if (end < candidate.startLine || end > lines.length) {
      throw new ToolInputError(
        `${candidate.path} has ${String(lines.length)} lines; the anchor ${String(candidate.startLine)}–${String(end)} is out of range`,
      )
    }
    for (const id of candidate.commandCallIds ?? []) {
      if (!commandRuns.has(id)) throw new ToolInputError(`No run_command call with id ${id}`)
    }
    return {
      candidate,
      anchoredText: lines.slice(candidate.startLine - 1, end).join('\n'),
      toolCallId,
    }
  }

  async function run(
    name: string,
    args: unknown,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    if (completion !== null) {
      throw new ToolInputError('The review is already finished; do not call more tools')
    }
    switch (name) {
      case 'read_file': {
        const input = readFileArgs(args)
        if (input === null)
          throw new ToolInputError('read_file needs { path, startLine?, endLine? }')
        const lines = (await readSource(input.path)).split(/\r?\n/)
        const start = Math.max(1, input.startLine ?? 1)
        const end = Math.min(lines.length, input.endLine ?? lines.length)
        if (start > lines.length) {
          throw new ToolInputError(`${input.path} has ${String(lines.length)} lines`)
        }
        const width = String(end).length
        return cap(
          lines
            .slice(start - 1, end)
            .map((line, index) => `${String(start + index).padStart(width)}: ${line}`)
            .join('\n'),
        )
      }
      case 'read_dependency_file': {
        const input = readFileArgs(args)
        if (input === null) {
          throw new ToolInputError('read_dependency_file needs { path, startLine?, endLine? }')
        }
        if (host.cell === null) {
          throw new ToolInputError('read_dependency_file is unavailable without an execution cell')
        }
        let result: CellCommandResult
        try {
          result = await readDependencyFileInCell(host.cell, input, MAX_TOOL_OUTPUT_CHARS, signal)
        } catch (err) {
          throw new ToolInputError(errorMessage(err))
        }
        const output = host.scrub(result.output).trimEnd()
        if (result.timedOut) {
          throw new ToolInputError(
            `dependency read timed out after ${String(result.durationMs)} ms`,
          )
        }
        if (result.exitCode !== 0) {
          throw new ToolInputError(
            `Cannot read dependency ${input.path}: ${output || `exit ${String(result.exitCode)}`}`,
          )
        }
        return cap(output)
      }
      case 'list_dir': {
        const input = listDirArgs(args) ?? { path: '.' }
        const dir = jailPath(root, input.path ?? '.')
        const entries = await readdir(dir, { withFileTypes: true })
        return cap(
          entries
            .filter((entry) => !SKIPPED_DIRS.has(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 400)
            .map((entry) => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`)
            .join('\n'),
        )
      }
      case 'search_code': {
        const input = searchArgs(args)
        if (input === null) throw new ToolInputError('search_code needs { pattern, path? }')
        const regex = toRegExp(input.pattern)
        const start = jailPath(root, input.path ?? '.')
        const info = await lstat(start).catch(() => null)
        if (info === null) throw new ToolInputError(`No such path: ${input.path ?? '.'}`)
        const hits: string[] = []
        const files: AsyncIterable<string> | Iterable<string> = info.isDirectory()
          ? walkFiles(start)
          : [start]
        for await (const file of files) {
          const text = await readSource(relative(root, file)).catch(() => null)
          if (text === null || text.includes('\u0000')) continue
          const relPath = relative(root, file).replace(/\\/g, '/')
          const lines = text.split(/\r?\n/)
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? ''
            if (regex.test(line))
              hits.push(`${relPath}:${String(index + 1)}: ${line.trim().slice(0, 300)}`)
            if (hits.length >= MAX_SEARCH_HITS) break
          }
          if (hits.length >= MAX_SEARCH_HITS) break
        }
        if (hits.length === 0) return 'No matches.'
        const note =
          hits.length >= MAX_SEARCH_HITS ? `\n…(stopped at ${String(MAX_SEARCH_HITS)} hits)` : ''
        return cap(hits.join('\n') + note)
      }
      case 'git_diff': {
        const input = gitDiffArgs(args)
        if (input === null) throw new ToolInputError('git_diff needs { path }')
        const file = host.context.files.find((entry) => entry.path === input.path)
        if (file === undefined) throw new ToolInputError(`${input.path} is not a changed file`)
        const diff = await readFileDiff(root, host.context.mergeBase, input.path)
        signal.throwIfAborted()
        const offset = input.offset ?? 0
        const nextOffset = offset + MAX_TOOL_OUTPUT_CHARS
        return (
          diff.slice(offset, nextOffset) +
          (nextOffset < diff.length
            ? `\n…(more diff available; call git_diff with offset ${String(nextOffset)})`
            : '')
        )
      }
      case 'run_command': {
        const input = runCommandArgs(args)
        if (input === null)
          throw new ToolInputError('run_command needs { argv: string[], timeoutMs? }')
        if (host.shellDecision !== 'allow' || host.cell === null) {
          throw new ToolInputError('run_command is denied under this run’s permission profile')
        }
        const [file, ...rest] = input.argv
        if (file === undefined) throw new ToolInputError('argv is empty')
        const result = await host.cell.run({
          target: 'head',
          argv: [file, ...rest],
          timeoutMs: input.timeoutMs ?? RUN_COMMAND_DEFAULT_TIMEOUT_MS,
          maxOutputBytes: MAX_TOOL_OUTPUT_CHARS * 4,
          signal,
        })
        const scrubbed = { ...result, output: host.scrub(result.output) }
        commandRuns.set(toolCallId, scrubbed)
        const status = scrubbed.timedOut ? 'timed out' : `exit ${String(scrubbed.exitCode)}`
        // API-generated call ids may only exist in transport metadata. Expose
        // the recorded id explicitly so the model can cite this evidence.
        return `${status} (${String(scrubbed.durationMs)} ms)\ncommandCallId: ${JSON.stringify(toolCallId)}\n${wrapExternalContent('run_command', cap(scrubbed.output))}`
      }
      case 'record_suspicion': {
        const input = suspicionSchema.parse(args)
        if (suspicions.length >= 20)
          throw new ToolInputError('At most 20 suspicions; settle the existing ones')
        const lines = (await readSource(input.path)).split(/\r?\n/)
        if (input.startLine > lines.length)
          throw new ToolInputError('Suspicion anchor is out of range')
        const id = `suspicion-${String(suspicions.length + 1)}`
        suspicions.push({ ...input, id })
        return `Recorded ${id}. Resolve it in finish_review.dispositions; it cannot be silently omitted.`
      }
      case 'report_finding': {
        const candidate = decodeCandidate(args)
        if (candidate === null) {
          throw new ToolInputError(
            'report_finding needs path, startLine, class, severity, confidence, a claim (8–400 chars) and a reason (8–1200 chars)',
          )
        }
        reported.push(await prepareCandidate(candidate, toolCallId))
        return `Recorded finding ${String(reported.length)} at ${candidate.path}:${String(candidate.startLine)}.`
      }
      case 'finish_review': {
        const parsed = reviewClosureSchema.safeParse(args)
        if (!parsed.success) {
          const validationError = describeClosureValidation(parsed.error)
          completionError = validationError
          throw new ToolInputError(
            `finish_review needs { checked, couldNotVerify, findings? }; validation failed: ${validationError}`,
          )
        }
        const input = parsed.data
        // Validate the whole closure before recording any of it. A malformed
        // later candidate must not leave a half-applied review that duplicates
        // findings when the model retries the tool call.
        let closureFindings: ReportedCandidate[]
        try {
          closureFindings = await Promise.all(
            input.findings.map((candidate) => prepareCandidate(candidate, toolCallId)),
          )
        } catch (err) {
          completionError = errorMessage(err)
          throw err
        }
        const allFindings = [...reported, ...closureFindings]
        const seen = new Set<string>()
        try {
          for (const disposition of input.dispositions) {
            if (
              !suspicions.some((entry) => entry.id === disposition.id) ||
              seen.has(disposition.id)
            ) {
              throw new ToolInputError(`Unknown or duplicate suspicion ${disposition.id}`)
            }
            seen.add(disposition.id)
            if (disposition.status === 'reported') {
              if (
                disposition.findingIndex === undefined ||
                allFindings[disposition.findingIndex - 1] === undefined
              ) {
                throw new ToolInputError(
                  `${disposition.id} must reference an existing findingIndex`,
                )
              }
            } else if (disposition.findingIndex !== undefined) {
              throw new ToolInputError(`${disposition.id} is not reported; omit findingIndex`)
            }
            if (
              disposition.status === 'unresolved' &&
              !input.couldNotVerify.includes(disposition.id)
            ) {
              throw new ToolInputError(
                `Include unresolved ${disposition.id} and its uncertainty in couldNotVerify`,
              )
            }
          }
          const missing = suspicions.filter((entry) => !seen.has(entry.id))
          if (missing.length > 0)
            throw new ToolInputError(
              `Missing dispositions: ${missing.map((entry) => entry.id).join(', ')}`,
            )
        } catch (err) {
          completionError = errorMessage(err)
          throw err
        }
        reported.push(...closureFindings)
        completion = { checked: input.checked, couldNotVerify: input.couldNotVerify }
        completionError = null
        return 'Review completion recorded. Stop now.'
      }
      default:
        throw new ToolInputError(`Unknown tool: ${name}`)
    }
  }

  return {
    async execute(name, args, signal, toolCallId): Promise<string> {
      try {
        signal.throwIfAborted()
        return await run(name, args, signal, toolCallId)
      } catch (err) {
        if (err instanceof ToolInputError) return `Error: ${err.message}`
        return `Error: ${errorMessage(err)}`
      }
    },
    reported: () => reported,
    suspicions: () => suspicions,
    completion: () => completion,
    completionError: () => completionError,
    commandRuns: () => commandRuns,
  }
}
