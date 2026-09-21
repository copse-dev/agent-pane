// The reviewer's tools (Stage 2). Reads are served by the orchestrator over the
// head checkout as data, jailed to it; the one tool that executes anything,
// `run_command`, is brokered into the execution cell and gated by the run's
// permission profile. Candidate findings come back through `report_finding`
// as structured objects, never as prose to parse.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import type { LLMTool } from '@copse/llm/wire-types.ts'
import type { HeadlessPermissionDecision } from '@copse/agent/headless-contract.ts'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import type { ReviewContext } from './context.ts'
import { FINDING_CLASSES, FINDING_CONFIDENCES, FINDING_SEVERITIES } from './finding.ts'
import type { CellCommandResult, ExecutionCell } from './isolation.ts'

export const REVIEWER_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search_code',
  'git_diff',
  'run_command',
  'report_finding',
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
      description: 'The full diff of one changed file against the merge-base, untruncated.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A changed file' } },
        required: ['path'],
      },
    },
    {
      name: 'run_command',
      description:
        'Run a program in an isolated copy of the change (no shell: pass argv). Use it to run a test or a script that settles a question. Output is capped.',
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
      name: 'report_finding',
      description:
        'Report one defect in the change. Anchor it at the exact lines; give a falsifiable one-sentence claim and the specific reason.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          class: { type: 'string', enum: [...FINDING_CLASSES] },
          severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
          confidence: { type: 'string', enum: [...FINDING_CONFIDENCES] },
          claim: { type: 'string', description: 'One sentence, falsifiable' },
          reason: { type: 'string', description: 'Why these lines are wrong' },
          commandCallIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of run_command calls whose output demonstrates the defect',
          },
        },
        required: ['path', 'startLine', 'class', 'severity', 'confidence', 'claim', 'reason'],
      },
    },
  ]
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
const gitDiffArgs = decodeWithSchema(z.object({ path: z.string().min(1) }))
const runCommandArgs = decodeWithSchema(
  z.object({
    argv: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().max(RUN_COMMAND_MAX_TIMEOUT_MS).optional(),
  }),
)
const decodeCandidate = decodeWithSchema(candidateFindingSchema)

class ToolInputError extends Error {}

/** Resolve a repo-relative path inside the head checkout; refuse anything outside it. */
export function jailPath(root: string, path: string): string {
  const absRoot = resolve(root)
  const target = resolve(absRoot, path || '.')
  const rel = relative(absRoot, target)
  if (
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    resolve(target) !== target
  ) {
    throw new ToolInputError(`Path is outside the change under review: ${path}`)
  }
  return target
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
      info = await stat(path)
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
  /** Every `run_command` result, by tool-call id, for evidence. */
  commandRuns(): ReadonlyMap<string, CellCommandResult>
}

export function createReviewerToolExecutor(host: ReviewerToolHost): ReviewerToolExecutor {
  const reported: ReportedCandidate[] = []
  const commandRuns = new Map<string, CellCommandResult>()
  const root = host.headCheckout

  async function readSource(path: string): Promise<string> {
    const file = jailPath(root, path)
    try {
      return await readFile(file, 'utf8')
    } catch (err) {
      throw new ToolInputError(`Cannot read ${path}: ${errorMessage(err)}`)
    }
  }

  async function run(name: string, args: unknown, toolCallId: string): Promise<string> {
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
        const info = await stat(start).catch(() => null)
        if (info === null) throw new ToolInputError(`No such path: ${input.path ?? '.'}`)
        const hits: string[] = []
        const files: AsyncIterable<string> | Iterable<string> = info.isDirectory()
          ? walkFiles(start)
          : [start]
        for await (const file of files) {
          const text = await readFile(file, 'utf8').catch(() => null)
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
        if (file.dropped !== undefined) {
          return `The diff for ${input.path} was omitted from the review (${file.dropped}); read the file directly if it matters.`
        }
        return cap(file.text)
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
        })
        const scrubbed = { ...result, output: host.scrub(result.output) }
        commandRuns.set(toolCallId, scrubbed)
        const status = scrubbed.timedOut ? 'timed out' : `exit ${String(scrubbed.exitCode)}`
        return `${status} (${String(scrubbed.durationMs)} ms)\n${wrapExternalContent('run_command', cap(scrubbed.output))}`
      }
      case 'report_finding': {
        const candidate = decodeCandidate(args)
        if (candidate === null) {
          throw new ToolInputError(
            'report_finding needs path, startLine, class, severity, confidence, a claim (8–400 chars) and a reason (8–1200 chars)',
          )
        }
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
        reported.push({
          candidate,
          anchoredText: lines.slice(candidate.startLine - 1, end).join('\n'),
          toolCallId,
        })
        return `Recorded finding ${String(reported.length)} at ${candidate.path}:${String(candidate.startLine)}.`
      }
      default:
        throw new ToolInputError(`Unknown tool: ${name}`)
    }
  }

  return {
    async execute(name, args, _signal, toolCallId): Promise<string> {
      try {
        return await run(name, args, toolCallId)
      } catch (err) {
        if (err instanceof ToolInputError) return `Error: ${err.message}`
        return `Error: ${errorMessage(err)}`
      }
    },
    reported: () => reported,
    commandRuns: () => commandRuns,
  }
}
