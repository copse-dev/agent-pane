// Model-backed prompt-section ablation harness (#744).
//
// Holds the task and model constant, varies one named base-prompt section at a
// time, grades the workspace/final answer, and scores the finished transcript
// against the deterministic working-style doctrine. Real-model runs are trend
// evidence for nightly/label-gated CI, never a per-PR merge gate.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import {
  createLMStudioProvider,
  createOpenRouterProvider,
  createProvider,
} from '@copse/llm/create-provider.ts'
import { MockLLMProvider } from '@copse/llm/mock-provider.ts'
import type { LLMMessage, LLMProvider, LLMTool } from '@copse/llm/wire-types.ts'
import {
  assemblePromptFromSections,
  buildPromptSections,
  PROMPT_SECTION_IDS,
  type PromptSectionId,
  type PromptSectionVars,
} from '../src/main/services/agent-prompt-sections.ts'
import { GIT_BRANCH_SAFETY, SHARED_WORKING_STYLE } from '../src/main/services/agent-prompt.ts'
import {
  DOCTRINE_RULE_IDS,
  scoreDoctrineCompliance,
  type DoctrineComplianceReport,
  type DoctrineRuleId,
  type DoctrineToolCall,
  type UserIntent,
} from '../src/shared/agent/doctrine-compliance.ts'
import { expectRecord } from '../src/shared/unknown-value.mts'
import { z } from 'zod'

export const DOCTRINE_EVAL_PROVIDER_IDS = [
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'mock',
] as const

export type DoctrineEvalProviderId = (typeof DOCTRINE_EVAL_PROVIDER_IDS)[number]

export interface DoctrineEvalTask {
  id: string
  description?: string | undefined
  prompt: string
  fixture?: string | undefined
  userIntent: UserIntent
  inScopePaths?: string[] | undefined
  allowedCommands?: string[] | undefined
  mockOnly?: boolean | undefined
  grade:
    | { kind: 'shell'; command: string }
    | { kind: 'file-contains'; path: string; needle: string }
    | { kind: 'final-contains'; needle: string }
  maxSteps?: number | undefined
  timeoutMs?: number | undefined
}

export interface DoctrineEvalArm {
  id: string
  omit: PromptSectionId[]
}

export interface DoctrineEvalAttempt {
  taskId: string
  armId: string
  omit: PromptSectionId[]
  attempt: number
  solved: boolean
  gradeDetail: string
  doctrine: DoctrineComplianceReport
  toolCalls: DoctrineToolCall[]
  finalMessage: string
  inputTokens: number
  outputTokens: number
  usageEstimated: boolean
  durationMs: number
  trace: string
  error?: string | undefined
}

export interface DoctrineEvalArmSummary {
  armId: string
  omit: PromptSectionId[]
  solved: number
  doctrinePassed: number
  total: number
  solveRate: number
  doctrinePassRate: number
  tokensPerSolve: number | null
  tokensEstimated: boolean
  inputTokens: number
  outputTokens: number
  perRulePassRate: Record<DoctrineRuleId, number>
  solveRateDeltaVsFull: number
  doctrinePassRateDeltaVsFull: number
  tokensPerSolveDeltaVsFull: number | null
}

export interface DoctrineEvalReport {
  schemaVersion: 1
  generatedAt: string
  provider: DoctrineEvalProviderId
  model: string
  repeats: number
  taskIds: string[]
  arms: DoctrineEvalArmSummary[]
  attempts: DoctrineEvalAttempt[]
}

export interface DoctrineEvalOptions {
  providerId: DoctrineEvalProviderId
  model?: string | undefined
  baseUrl?: string | undefined
  repeats: number
  sections: PromptSectionId[]
  tasksDir: string
  taskId?: string | undefined
  outDir: string
  baselinePath: string
  updateBaseline: boolean
  keepWorkspaces: boolean
  requireSolved: boolean
  requireDoctrine: boolean
}

interface DoctrineBaselineArm {
  solveRate: number
  doctrinePassRate: number
  tokensPerSolve: number | null
  tokensEstimated: boolean
  perRulePassRate: Record<DoctrineRuleId, number>
}

interface DoctrineBaselineEntry {
  recordedAt: string
  repeats: number
  taskIds: string[]
  arms: Record<string, DoctrineBaselineArm>
}

interface DoctrineBaselines {
  schemaVersion: 1
  entries: Record<string, DoctrineBaselineEntry>
}

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000
const SHELL_TIMEOUT_MS = 120_000
const MAX_TOOL_OUTPUT = 12_000

const doctrineTaskSchema: z.ZodType<DoctrineEvalTask> = z.object({
  id: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  fixture: z.string().optional(),
  userIntent: z.enum(['question', 'request', 'unknown']),
  inScopePaths: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
  mockOnly: z.boolean().optional(),
  grade: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('shell'), command: z.string() }),
    z.object({ kind: z.literal('file-contains'), path: z.string(), needle: z.string() }),
    z.object({ kind: z.literal('final-contains'), needle: z.string() }),
  ]),
  maxSteps: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

const ruleRatesSchema: z.ZodType<Record<DoctrineRuleId, number>> = z.object({
  leadWithOutcome: z.number(),
  readableOverTerse: z.number(),
  questionVsRequest: z.number(),
  faithfulReporting: z.number(),
  scopeDiscipline: z.number(),
  noNarratingComments: z.number(),
  followExplicitConstraints: z.number(),
})
const baselineArmSchema: z.ZodType<DoctrineBaselineArm> = z.object({
  solveRate: z.number(),
  doctrinePassRate: z.number(),
  tokensPerSolve: z.number().nullable(),
  tokensEstimated: z.boolean(),
  perRulePassRate: ruleRatesSchema,
})
const baselineEntrySchema: z.ZodType<DoctrineBaselineEntry> = z.object({
  recordedAt: z.string(),
  repeats: z.number().int().positive(),
  taskIds: z.array(z.string()),
  arms: z.record(z.string(), baselineArmSchema),
})
const baselinesSchema: z.ZodType<DoctrineBaselines> = z.object({
  schemaVersion: z.literal(1),
  entries: z.record(z.string(), baselineEntrySchema),
})

export const DOCTRINE_EVAL_TOOLS: LLMTool[] = [
  {
    name: 'list_dir',
    description: 'List files at a path relative to the workspace root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file relative to the workspace root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file relative to the workspace root',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'str_replace',
    description: 'Replace one exact substring in a workspace file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file relative to the workspace root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'rename_file',
    description: 'Rename a file within the workspace',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'make_directory',
    description: 'Create a directory relative to the workspace root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run one of the task fixture commands allowed by the eval manifest',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
]

const EVAL_PROMPT_VARS: PromptSectionVars = {
  tools: `- list_dir: List workspace files
- read_file: Read a workspace file
- write_file: Write a complete workspace file
- str_replace: Replace one exact substring in a workspace file
- delete_file: Delete a workspace file
- rename_file: Rename a workspace file
- make_directory: Create a workspace directory`,
  toolTail:
    '- run_shell: Run a task command when validation is needed; only commands allowed by the eval task are accepted',
  gather:
    'Use the read tools as needed, then finish with a clear written answer in plain language.',
  avoidRepeat: 'Do not re-read the same paths; use run_shell only when validation is needed.',
  understand: 'Read the file first',
  inspectVerb: 'read',
  toolChoice: `- Use read_file and list_dir for workspace inspection, not run_shell
- Use the dedicated file tools for edits
- Reserve run_shell for the task's validation command`,
  workingStyle: SHARED_WORKING_STYLE,
  gitBranchSafety: GIT_BRANCH_SAFETY,
}

function replaceOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from)
  if (first === -1) throw new Error('old_string was not found')
  if (text.indexOf(from, first + from.length) !== -1) {
    throw new Error('old_string matched more than once')
  }
  return `${text.slice(0, first)}${to}${text.slice(first + from.length)}`
}

function jailPath(workspace: string, path: string): string {
  const absRoot = resolve(workspace)
  const absTarget = resolve(absRoot, path || '.')
  const rel = relative(absRoot, absTarget)
  if (rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside workspace: ${path}`)
  }
  return absTarget
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a string`)
  return value
}

async function executeTool(
  workspace: string,
  task: DoctrineEvalTask,
  name: string,
  rawArgs: unknown,
): Promise<string> {
  const args = expectRecord(rawArgs)
  if (name === 'list_dir') {
    const path = typeof args['path'] === 'string' ? args['path'] : '.'
    const dir = jailPath(workspace, path)
    return readdirSync(dir)
      .slice(0, 200)
      .map((entry) => `${statSync(join(dir, entry)).isDirectory() ? 'd' : 'f'} ${entry}`)
      .join('\n')
  }
  if (name === 'read_file') {
    return (await readFile(jailPath(workspace, stringArg(args, 'path')), 'utf8')).slice(
      0,
      MAX_TOOL_OUTPUT,
    )
  }
  if (name === 'write_file') {
    const path = stringArg(args, 'path')
    const content = stringArg(args, 'content')
    const file = jailPath(workspace, path)
    mkdirSync(dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
    return `Wrote ${String(content.length)} chars to ${path}`
  }
  if (name === 'str_replace') {
    const path = stringArg(args, 'path')
    const file = jailPath(workspace, path)
    const current = await readFile(file, 'utf8')
    const updated = replaceOnce(
      current,
      stringArg(args, 'old_string'),
      stringArg(args, 'new_string'),
    )
    await writeFile(file, updated, 'utf8')
    return `Replaced text in ${path}`
  }
  if (name === 'delete_file') {
    const path = stringArg(args, 'path')
    rmSync(jailPath(workspace, path), { force: true })
    return `Deleted ${path}`
  }
  if (name === 'rename_file') {
    const from = stringArg(args, 'from')
    const to = stringArg(args, 'to')
    const target = jailPath(workspace, to)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(jailPath(workspace, from), target)
    return `Renamed ${from} to ${to}`
  }
  if (name === 'make_directory') {
    const path = stringArg(args, 'path')
    mkdirSync(jailPath(workspace, path), { recursive: true })
    return `Created ${path}`
  }
  if (name === 'run_shell') {
    const command = stringArg(args, 'command')
    if (!(task.allowedCommands ?? []).includes(command)) {
      throw new Error(`Command is not allowed by task '${task.id}': ${command}`)
    }
    const result = spawnSync(command, {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
    })
    return `exit=${String(result.status ?? 'timeout')}\n${`${result.stdout}${result.stderr}`.slice(0, MAX_TOOL_OUTPUT)}`
  }
  throw new Error(`Unknown tool: ${name}`)
}

export function buildDoctrineEvalPrompt(
  workspace: string,
  omit: readonly PromptSectionId[],
): string {
  return assemblePromptFromSections(buildPromptSections(EVAL_PROMPT_VARS), omit)
    .replace('{WORKSPACE_ROOT}', workspace)
    .replace('{SKILLS_TOOLS_LINE}', '')
}

export function buildDoctrineEvalArms(sections: readonly PromptSectionId[]): DoctrineEvalArm[] {
  return [
    { id: 'full', omit: [] },
    ...sections.map((section) => ({ id: `omit-${section}`, omit: [section] })),
  ]
}

function loadTasks(options: DoctrineEvalOptions): DoctrineEvalTask[] {
  const tasks = readdirSync(options.tasksDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) =>
      doctrineTaskSchema.parse(
        JSON.parse(readFileSync(join(options.tasksDir, file), 'utf8')) as unknown,
      ),
    )
    .filter((task) => (options.providerId === 'mock' ? task.mockOnly === true : !task.mockOnly))
  return options.taskId ? tasks.filter((task) => task.id === options.taskId) : tasks
}

function prepareWorkspace(task: DoctrineEvalTask): string {
  const workspace = mkdtempSync(join(tmpdir(), 'copse-doctrine-eval-'))
  if (task.fixture) cpSync(resolve(task.fixture), workspace, { recursive: true })
  return workspace
}

function finalAssistantText(messages: readonly LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && typeof message.content === 'string') {
      return message.content.trim()
    }
  }
  return ''
}

function gradeAttempt(
  task: DoctrineEvalTask,
  workspace: string,
  finalMessage: string,
): { solved: boolean; detail: string } {
  if (task.grade.kind === 'final-contains') {
    const solved = finalMessage.toLowerCase().includes(task.grade.needle.toLowerCase())
    return {
      solved,
      detail: solved ? 'final answer contains expected text' : 'expected text missing',
    }
  }
  if (task.grade.kind === 'file-contains') {
    try {
      const content = readFileSync(jailPath(workspace, task.grade.path), 'utf8')
      const solved = content.includes(task.grade.needle)
      return { solved, detail: solved ? 'needle found' : 'needle missing' }
    } catch (error) {
      return { solved: false, detail: `grade file unreadable: ${String(error)}` }
    }
  }
  if (!(task.allowedCommands ?? []).includes(task.grade.command)) {
    return { solved: false, detail: 'grade command is not in allowedCommands' }
  }
  const result = spawnSync(task.grade.command, {
    cwd: workspace,
    shell: true,
    encoding: 'utf8',
    timeout: SHELL_TIMEOUT_MS,
  })
  const tail = `${result.stdout}${result.stderr}`.trim().slice(-500)
  return {
    solved: result.status === 0,
    detail: `exit=${String(result.status ?? 'timeout')} ${tail}`.trim(),
  }
}

function recordArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return { ...expectRecord(args) }
}

async function runAttempt(
  task: DoctrineEvalTask,
  arm: DoctrineEvalArm,
  attempt: number,
  provider: LLMProvider,
  outDir: string,
  keepWorkspace: boolean,
): Promise<DoctrineEvalAttempt> {
  const workspace = prepareWorkspace(task)
  const tracePath = join(outDir, `${task.id}--${arm.id}--${String(attempt)}.jsonl`)
  const traceLines: string[] = []
  const toolCalls: DoctrineToolCall[] = []
  const callsById = new Map<string, DoctrineToolCall>()
  const usage = { inputTokens: 0, outputTokens: 0, chunks: 0 }
  const messages: LLMMessage[] = [
    { role: 'system', content: buildDoctrineEvalPrompt(workspace, arm.omit) },
    { role: 'user', content: task.prompt },
  ]
  let error: string | undefined
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)

  try {
    await runAgentLoop({
      provider,
      messages,
      tools: DOCTRINE_EVAL_TOOLS,
      executeTool: (name, args) => executeTool(workspace, task, name, args),
      signal: controller.signal,
      maxSteps: task.maxSteps ?? 16,
      onChunk: (chunk: AgentStreamChunk) => {
        if (
          chunk.type === 'text' ||
          chunk.type === 'text_replace' ||
          chunk.type === 'tool_call' ||
          chunk.type === 'tool_result' ||
          chunk.type === 'usage' ||
          chunk.type === 'done'
        ) {
          traceLines.push(JSON.stringify(chunk))
        }
        if (chunk.type === 'tool_call') {
          const args = recordArgs(chunk.toolCall.args)
          const call: DoctrineToolCall = {
            name: chunk.toolCall.name,
            status: 'running',
            ...(args !== undefined ? { args } : {}),
          }
          toolCalls.push(call)
          callsById.set(chunk.toolCall.id, call)
        }
        if (chunk.type === 'tool_result') {
          const call = callsById.get(chunk.toolCallId)
          if (call) {
            call.result = chunk.result
            call.status = chunk.isError ? 'error' : 'done'
          }
        }
        if (chunk.type === 'usage') {
          usage.chunks += 1
          usage.inputTokens += chunk.inputTokens
          usage.outputTokens += chunk.outputTokens
        }
      },
    })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(timer)
  }

  const finalMessage = finalAssistantText(messages)
  const usageEstimated = usage.chunks === 0
  if (usageEstimated) {
    usage.inputTokens = Math.round(JSON.stringify(messages.slice(0, 2)).length / 4)
    usage.outputTokens = Math.round(finalMessage.length / 4)
  }
  const grade = gradeAttempt(task, workspace, finalMessage)
  const doctrine = scoreDoctrineCompliance({
    userMessage: task.prompt,
    userIntent: task.userIntent,
    ...(task.inScopePaths !== undefined ? { inScopePaths: task.inScopePaths } : {}),
    toolCalls,
    finalMessage,
  })
  writeFileSync(tracePath, `${traceLines.join('\n')}\n`, 'utf8')
  if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true })

  return {
    taskId: task.id,
    armId: arm.id,
    omit: [...arm.omit],
    attempt,
    solved: grade.solved && error === undefined,
    gradeDetail: grade.detail,
    doctrine,
    toolCalls,
    finalMessage,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usageEstimated,
    durationMs: Date.now() - started,
    trace: tracePath,
    ...(error !== undefined ? { error } : {}),
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function withoutDeltas(
  arm: DoctrineEvalArm,
  attempts: readonly DoctrineEvalAttempt[],
): Omit<
  DoctrineEvalArmSummary,
  'solveRateDeltaVsFull' | 'doctrinePassRateDeltaVsFull' | 'tokensPerSolveDeltaVsFull'
> {
  const selected = attempts.filter((attempt) => attempt.armId === arm.id)
  const solved = selected.filter((attempt) => attempt.solved).length
  const doctrinePassed = selected.filter((attempt) => attempt.doctrine.pass).length
  const inputTokens = selected.reduce((sum, attempt) => sum + attempt.inputTokens, 0)
  const outputTokens = selected.reduce((sum, attempt) => sum + attempt.outputTokens, 0)
  const perRulePassRate = Object.fromEntries(
    DOCTRINE_RULE_IDS.map((id) => [
      id,
      rate(
        selected.filter(
          (attempt) => attempt.doctrine.results.find((result) => result.id === id)?.pass,
        ).length,
        selected.length,
      ),
    ]),
  )
  return {
    armId: arm.id,
    omit: [...arm.omit],
    solved,
    doctrinePassed,
    total: selected.length,
    solveRate: rate(solved, selected.length),
    doctrinePassRate: rate(doctrinePassed, selected.length),
    tokensPerSolve: solved === 0 ? null : Math.round((inputTokens + outputTokens) / solved),
    tokensEstimated: selected.some((attempt) => attempt.usageEstimated),
    inputTokens,
    outputTokens,
    perRulePassRate: ruleRatesSchema.parse(perRulePassRate),
  }
}

export function summarizeDoctrineEval(
  arms: readonly DoctrineEvalArm[],
  attempts: readonly DoctrineEvalAttempt[],
): DoctrineEvalArmSummary[] {
  const base = arms.map((arm) => withoutDeltas(arm, attempts))
  const full = base.find((summary) => summary.armId === 'full')
  if (!full) throw new Error('Doctrine eval matrix requires a full arm.')
  return base.map((summary) => ({
    ...summary,
    solveRateDeltaVsFull: summary.solveRate - full.solveRate,
    doctrinePassRateDeltaVsFull: summary.doctrinePassRate - full.doctrinePassRate,
    tokensPerSolveDeltaVsFull:
      summary.tokensPerSolve === null || full.tokensPerSolve === null
        ? null
        : summary.tokensPerSolve - full.tokensPerSolve,
  }))
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`
}

export function renderDoctrineEvalMarkdown(report: DoctrineEvalReport): string {
  const lines = [
    '# Doctrine prompt-section ablation',
    '',
    `- Provider/model: \`${report.provider}:${report.model}\``,
    `- Tasks: ${report.taskIds.join(', ')}`,
    `- Repeats: ${String(report.repeats)}`,
    `- Generated: ${report.generatedAt}`,
    '',
    '| Arm | Solved | Doctrine pass | Tokens / solve | Δ solve | Δ doctrine | Δ tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.armId} | ${String(arm.solved)}/${String(arm.total)} (${percent(arm.solveRate)}) | ${String(arm.doctrinePassed)}/${String(arm.total)} (${percent(arm.doctrinePassRate)}) | ${arm.tokensPerSolve === null ? '—' : `${arm.tokensEstimated ? '~' : ''}${String(arm.tokensPerSolve)}`} | ${signedPercent(arm.solveRateDeltaVsFull)} | ${signedPercent(arm.doctrinePassRateDeltaVsFull)} | ${arm.tokensPerSolveDeltaVsFull === null ? '—' : `${arm.tokensPerSolveDeltaVsFull >= 0 ? '+' : ''}${String(arm.tokensPerSolveDeltaVsFull)}`} |`,
    )
  }
  lines.push('', '## Per-rule pass rates', '')
  lines.push(`| Arm | ${DOCTRINE_RULE_IDS.join(' | ')} |`)
  lines.push(`| --- | ${DOCTRINE_RULE_IDS.map(() => '---:').join(' | ')} |`)
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.armId} | ${DOCTRINE_RULE_IDS.map((id) => percent(arm.perRulePassRate[id])).join(' | ')} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function providerModelKey(provider: DoctrineEvalProviderId, model: string): string {
  return `${provider}:${model}`
}

function loadBaselines(path: string): DoctrineBaselines {
  try {
    return baselinesSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return { schemaVersion: 1, entries: {} }
  }
}

function updateBaseline(path: string, report: DoctrineEvalReport): void {
  const baselines = loadBaselines(path)
  baselines.entries[providerModelKey(report.provider, report.model)] = {
    recordedAt: report.generatedAt,
    repeats: report.repeats,
    taskIds: report.taskIds,
    arms: Object.fromEntries(
      report.arms.map((arm) => [
        arm.armId,
        {
          solveRate: arm.solveRate,
          doctrinePassRate: arm.doctrinePassRate,
          tokensPerSolve: arm.tokensPerSolve,
          tokensEstimated: arm.tokensEstimated,
          perRulePassRate: arm.perRulePassRate,
        },
      ]),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(baselines, null, 2)}\n`, 'utf8')
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for this doctrine eval provider.`)
  return value
}

function buildProvider(options: DoctrineEvalOptions): { provider: LLMProvider; model: string } {
  if (options.providerId === 'mock') return { provider: new MockLLMProvider(), model: 'mock' }
  if (options.providerId === 'lmstudio') {
    const model = options.model ?? requiredEnv('LM_STUDIO_MODEL')
    const baseUrl =
      options.baseUrl ?? process.env['LM_STUDIO_URL']?.trim() ?? 'http://localhost:1234/v1'
    const apiKey = process.env['LM_STUDIO_API_KEY']?.trim() ?? process.env['LM_API_TOKEN']?.trim()
    if (!apiKey) throw new Error('LM_STUDIO_API_KEY or LM_API_TOKEN is required.')
    return { provider: createLMStudioProvider(baseUrl, model, apiKey), model }
  }
  if (options.providerId === 'openrouter') {
    const model = options.model ?? requiredEnv('OPENROUTER_MODEL')
    return {
      provider: createOpenRouterProvider(model, requiredEnv('OPENROUTER_API_KEY')),
      model,
    }
  }
  if (options.providerId === 'openai') {
    const model = options.model ?? requiredEnv('OPENAI_MODEL')
    return {
      provider: createProvider(model, { openAiApiKey: requiredEnv('OPENAI_API_KEY') }),
      model,
    }
  }
  const model = options.model ?? requiredEnv('ANTHROPIC_MODEL')
  return {
    provider: createProvider(model, { anthropicApiKey: requiredEnv('ANTHROPIC_API_KEY') }),
    model,
  }
}

function orderedArms(
  arms: readonly DoctrineEvalArm[],
  taskIndex: number,
  attempt: number,
): DoctrineEvalArm[] {
  const offset = (taskIndex + attempt - 1) % arms.length
  return [...arms.slice(offset), ...arms.slice(0, offset)]
}

export async function runDoctrineEval(options: DoctrineEvalOptions): Promise<DoctrineEvalReport> {
  const tasks = loadTasks(options)
  if (tasks.length === 0)
    throw new Error('No doctrine eval tasks matched this provider/task filter.')
  const arms = buildDoctrineEvalArms(options.sections)
  const { provider, model } = buildProvider(options)
  mkdirSync(options.outDir, { recursive: true })
  const attempts: DoctrineEvalAttempt[] = []

  console.log(
    `eval:doctrine provider=${options.providerId} model=${model} tasks=${String(tasks.length)} arms=${String(arms.length)} repeats=${String(options.repeats)}`,
  )
  for (let attempt = 1; attempt <= options.repeats; attempt += 1) {
    for (const [taskIndex, task] of tasks.entries()) {
      for (const arm of orderedArms(arms, taskIndex, attempt)) {
        const result = await runAttempt(
          task,
          arm,
          attempt,
          provider,
          options.outDir,
          options.keepWorkspaces,
        )
        attempts.push(result)
        console.log(
          `  ${result.solved ? 'SOLVED' : 'unsolved'} ${task.id}/${arm.id} doctrine=${result.doctrine.pass ? 'pass' : result.doctrine.violations.join(',')} tokens=${String(result.inputTokens + result.outputTokens)}${result.usageEstimated ? '~' : ''}`,
        )
      }
    }
  }

  const report: DoctrineEvalReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: options.providerId,
    model,
    repeats: options.repeats,
    taskIds: tasks.map((task) => task.id),
    arms: summarizeDoctrineEval(arms, attempts),
    attempts,
  }
  writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(options.outDir, 'report.md'), renderDoctrineEvalMarkdown(report), 'utf8')
  if (options.updateBaseline) updateBaseline(options.baselinePath, report)
  console.log(`eval:doctrine report=${join(options.outDir, 'report.md')}`)
  if (options.requireSolved && attempts.some((attempt) => !attempt.solved)) {
    throw new Error('--require-solved set and at least one attempt was unsolved.')
  }
  if (options.requireDoctrine && attempts.some((attempt) => !attempt.doctrine.pass)) {
    throw new Error('--require-doctrine set and at least one attempt violated the doctrine.')
  }
  return report
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

function parseProvider(value: string | undefined): DoctrineEvalProviderId {
  const provider = value ?? 'lmstudio'
  const found = DOCTRINE_EVAL_PROVIDER_IDS.find((id) => id === provider)
  if (!found) throw new Error(`--provider must be one of: ${DOCTRINE_EVAL_PROVIDER_IDS.join(', ')}`)
  return found
}

function parseSections(value: string | undefined): PromptSectionId[] {
  const requested = (value ?? 'tools')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const sections: PromptSectionId[] = []
  for (const id of requested) {
    const found = PROMPT_SECTION_IDS.find((section) => section === id)
    if (!found) throw new Error(`Unknown prompt section '${id}'.`)
    if (!sections.includes(found)) sections.push(found)
  }
  if (sections.length === 0) throw new Error('--sections must name at least one prompt section.')
  return sections
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
}

export function parseDoctrineEvalArgs(args: readonly string[]): DoctrineEvalOptions {
  const providerId = parseProvider(argValue(args, '--provider'))
  const model = argValue(args, '--model')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    providerId,
    ...(model !== undefined ? { model } : {}),
    ...(argValue(args, '--base-url') !== undefined
      ? { baseUrl: argValue(args, '--base-url') }
      : {}),
    repeats: positiveInteger(argValue(args, '--repeats'), 3, '--repeats'),
    sections: parseSections(argValue(args, '--sections')),
    tasksDir: argValue(args, '--tasks') ?? 'benchmarks/doctrine/tasks',
    ...(argValue(args, '--task') !== undefined ? { taskId: argValue(args, '--task') } : {}),
    outDir:
      argValue(args, '--out') ??
      join(
        'bench-results',
        'doctrine',
        `${stamp}-${providerId}-${safePathPart(model ?? 'default')}`,
      ),
    baselinePath: argValue(args, '--baseline') ?? 'benchmarks/doctrine/doctrine-baseline.json',
    updateBaseline: args.includes('--update-baseline'),
    keepWorkspaces: args.includes('--keep-workspaces'),
    requireSolved: args.includes('--require-solved'),
    requireDoctrine: args.includes('--require-doctrine'),
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  await runDoctrineEval(parseDoctrineEvalArgs(args))
}

if (
  process.argv[1]?.endsWith('doctrine-eval-lib.mts') ||
  process.argv[1]?.endsWith('doctrine-eval-lib.cjs')
) {
  main().catch((error: unknown) => {
    console.error(`eval:doctrine: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
