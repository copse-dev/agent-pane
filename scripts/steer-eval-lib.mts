// Model-backed A/B harness for prompt steers.
//
// Every steer in the app ships with a unit test that asserts the string is
// wired up. Nothing asserts the string *does anything*. This harness closes
// that gap: it holds the task and the model constant, runs the same task twice
// — once with the steer text in the prompt, once without — and scores each
// finished transcript against deterministic behavioural checks.
//
// The headline number is **lift**: `withPassRate - withoutPassRate`. A steer
// whose lift is ~0 is not steering; it is paying tokens for nothing. Pass rate
// alone cannot tell you that, which is why the existing presence tests can be
// green while the prompt text is inert.
//
// Real-model runs are trend evidence for nightly / label-gated CI, never a
// per-PR merge gate. The mock provider arm is a harness self-test: it pins that
// the checkers actually discriminate pass from fail.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import {
  BROWSER_TOOLS_BLOCK,
  EXTERNAL_API_SAFETY_BLOCK,
  GIT_BRANCH_SAFETY,
  OPUS_5_RESPONSE_LENGTH_BLOCK,
  OPUS_5_TONE_REMINDER,
  READ_TERMINAL_BLOCK,
  SHARED_WORKING_STYLE,
} from '../src/main/services/agent-prompt.ts'
import { buildCommitSteeringPrompt } from '@copse/agent/commit-steering.ts'
import { TODO_STEERING_PROMPT } from '@copse/agent/todo-steering.ts'
import {
  FORCED_TODO_PLAN_PROMPT,
  FORCED_WRITTEN_PLAN_PROMPT,
} from '@copse/agent/forced-planning.ts'
import {
  LOOP_NUDGE_USER_MESSAGE,
  OPEN_TODOS_FINALIZE_NUDGE,
  OPEN_TODOS_FINALIZE_NUDGE_STRICT,
  STUCK_FINALIZE_NUDGE,
} from '@copse/agent/agent-loop-guards.ts'
import {
  REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '@copse/llm/provider-stop-reason.ts'
import { expectRecord } from '../src/shared/unknown-value.mts'
import { z } from 'zod'

export const STEER_EVAL_PROVIDER_IDS = [
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'mock',
] as const

export type SteerEvalProviderId = (typeof STEER_EVAL_PROVIDER_IDS)[number]

// ---------------------------------------------------------------------------
// Steer registry
//
// Every entry points at the SHIPPING constant, never a copy. That is the whole
// point: edit the prompt text in `agent-prompt.ts` and the eval re-runs against
// the edit. A pack that inlined its own copy of the text would go green while
// production drifted.
// ---------------------------------------------------------------------------

export const STEER_BLOCK_IDS = [
  'browserTools',
  'externalApiSafety',
  'opus5ResponseLength',
  'opus5ToneReminder',
  'readTerminal',
] as const
export const STEER_TURN_START_IDS = [
  'commitSteering',
  'forcedTodoPlan',
  'forcedWrittenPlan',
  'todoSteering',
] as const
export const STEER_NUDGE_IDS = [
  'loopNudge',
  'openTodosFinalize',
  'openTodosFinalizeStrict',
  'reasoningRunaway',
  'stuckFinalize',
  'truncationContinue',
] as const

export type SteerBlockId = (typeof STEER_BLOCK_IDS)[number]
export type SteerTurnStartId = (typeof STEER_TURN_START_IDS)[number]
export type SteerNudgeId = (typeof STEER_NUDGE_IDS)[number]

/** Steers appended to the assembled base prompt when a setting/pack enables them. */
export const STEER_BLOCK_TEXTS: Record<SteerBlockId, string> = {
  browserTools: BROWSER_TOOLS_BLOCK,
  externalApiSafety: EXTERNAL_API_SAFETY_BLOCK,
  opus5ResponseLength: OPUS_5_RESPONSE_LENGTH_BLOCK,
  opus5ToneReminder: OPUS_5_TONE_REMINDER,
  readTerminal: READ_TERMINAL_BLOCK,
}

/** Steers a `turnStart` hook injects into the system prompt for one turn. */
export const STEER_TURN_START_TEXTS: Record<SteerTurnStartId, string> = {
  commitSteering: buildCommitSteeringPrompt(),
  forcedTodoPlan: FORCED_TODO_PLAN_PROMPT,
  forcedWrittenPlan: FORCED_WRITTEN_PLAN_PROMPT,
  todoSteering: TODO_STEERING_PROMPT,
}

/** Steers injected mid-loop, after the model has already taken some steps. */
export const STEER_NUDGE_TEXTS: Record<SteerNudgeId, string> = {
  loopNudge: LOOP_NUDGE_USER_MESSAGE,
  openTodosFinalize: OPEN_TODOS_FINALIZE_NUDGE,
  openTodosFinalizeStrict: OPEN_TODOS_FINALIZE_NUDGE_STRICT,
  reasoningRunaway: REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  stuckFinalize: STUCK_FINALIZE_NUDGE,
  truncationContinue: TRUNCATION_CONTINUE_NUDGE,
}

/**
 * Neutral continuation for the control arm of a nudge A/B. Both arms get a
 * message so the only variable is the nudge *wording*, not the existence of an
 * extra turn — otherwise the control measures "no message" and the comparison
 * is meaningless.
 */
export const DEFAULT_NUDGE_CONTROL_TEXT = 'Continue.'

export type SteerSpec =
  | { kind: 'section'; ref: PromptSectionId }
  | { kind: 'block'; ref: SteerBlockId }
  | { kind: 'turnStart'; ref: SteerTurnStartId }
  | { kind: 'nudge'; ref: SteerNudgeId; afterSteps: number; controlText?: string | undefined }

/** Resolve the shipping text a steer contributes. */
export function steerText(spec: SteerSpec): string {
  if (spec.kind === 'block') return STEER_BLOCK_TEXTS[spec.ref]
  if (spec.kind === 'turnStart') return STEER_TURN_START_TEXTS[spec.ref]
  if (spec.kind === 'nudge') return STEER_NUDGE_TEXTS[spec.ref]
  return `section:${spec.ref}`
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type SteerCheck =
  | { id: string; kind: 'tool-used'; tool: string }
  | { id: string; kind: 'tool-not-used'; tool: string }
  | { id: string; kind: 'first-tool-is'; tool: string }
  | { id: string; kind: 'tool-arg-matches'; tool: string; arg: string; pattern: string }
  | { id: string; kind: 'tool-arg-not-matches'; tool: string; arg: string; pattern: string }
  | { id: string; kind: 'before-tool-matches'; tools: string[]; pattern: string }
  | { id: string; kind: 'final-matches'; pattern: string }
  | { id: string; kind: 'final-not-matches'; pattern: string }
  | { id: string; kind: 'final-max-chars'; max: number }
  | { id: string; kind: 'final-min-chars'; min: number }
  | { id: string; kind: 'max-tool-calls'; max: number }
  | { id: string; kind: 'shell'; command: string }

export interface SteerCheckResult {
  id: string
  kind: SteerCheck['kind']
  pass: boolean
  detail: string
}

export interface SteerEvalTask {
  id: string
  description?: string | undefined
  prompt: string
  /** Directory copied into the throwaway workspace before the run. */
  fixture?: string | undefined
  /**
   * Initialise a git repo on this branch before the run. `stageFixture`
   * (default true) commits the fixture as the repo's history so the agent sees
   * a normal project; set it false when the task needs a dirty tree instead.
   * `checkoutBranch` leaves the run on a second, non-default branch — needed to
   * test "preserve an existing working branch", which is unobservable when the
   * only branch is also the default one.
   */
  gitInit?:
    | {
        defaultBranch: string
        stageFixture?: boolean | undefined
        checkoutBranch?: string | undefined
      }
    | undefined
  /** Exact commands `run_shell` accepts. */
  allowedCommands?: string[] | undefined
  /** Regex alternatives to `allowedCommands`, so a model can phrase its own command. */
  allowedCommandPatterns?: string[] | undefined
  /** Mock-provider self-test task; excluded from real-model matrices (and vice versa). */
  mockOnly?: boolean | undefined
  /**
   * Tools to withhold from this task. Some steers exist precisely because a
   * tool is absent — FORCED_WRITTEN_PLAN_PROMPT is the fallback for turns where
   * `update_todos` was not offered — and cannot be evaluated with the full tool
   * list registered.
   */
  excludeTools?: string[] | undefined
  checks: SteerCheck[]
  maxSteps?: number | undefined
  timeoutMs?: number | undefined
}

export interface SteerPack {
  id: string
  description: string
  steer: SteerSpec
  /** What a healthy result looks like — documented next to the eval, not in a runbook. */
  gate?:
    | {
        /** Minimum `withPassRate - withoutPassRate`. The real signal. */
        minLift?: number | undefined
        /** Minimum absolute pass rate for the steered arm. */
        minWithPassRate?: number | undefined
        /**
         * Minimum fractional reduction in mean final-answer length, steered arm
         * versus control. For a steer whose whole job is response length, an
         * absolute character threshold is meaningless across models and tasks —
         * only the delta between the arms means anything.
         */
        meanFinalCharsReduction?: number | undefined
      }
    | undefined
  tasks: SteerEvalTask[]
}

export interface SteerEvalAttempt {
  packId: string
  taskId: string
  armId: 'with' | 'without'
  attempt: number
  compliant: boolean
  checks: SteerCheckResult[]
  toolNames: string[]
  finalMessage: string
  finalChars: number
  inputTokens: number
  outputTokens: number
  usageEstimated: boolean
  durationMs: number
  trace: string
  error?: string | undefined
}

export interface SteerEvalArmSummary {
  armId: 'with' | 'without'
  compliant: number
  total: number
  passRate: number
  perCheckPassRate: Record<string, number>
  meanFinalChars: number
  inputTokens: number
  outputTokens: number
}

export interface SteerEvalPackSummary {
  packId: string
  description: string
  steerKind: SteerSpec['kind']
  steerRef: string
  steerChars: number
  arms: SteerEvalArmSummary[]
  /** withPassRate - withoutPassRate. */
  lift: number
  /** Fractional reduction in mean final-answer length, steered arm vs control. */
  meanFinalCharsReduction: number
  gatePassed: boolean
  gateDetail: string
}

export interface SteerEvalReport {
  schemaVersion: 1
  generatedAt: string
  provider: SteerEvalProviderId
  model: string
  repeats: number
  packs: SteerEvalPackSummary[]
  attempts: SteerEvalAttempt[]
}

export interface SteerEvalOptions {
  providerId: SteerEvalProviderId
  model?: string | undefined
  baseUrl?: string | undefined
  repeats: number
  packsDir: string
  packId?: string | undefined
  outDir: string
  keepWorkspaces: boolean
  /** Fail the process when a pack misses its declared gate. */
  requireGates: boolean
}

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000
const SHELL_TIMEOUT_MS = 120_000
const MAX_TOOL_OUTPUT = 12_000

const steerCheckSchema: z.ZodType<SteerCheck> = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('tool-used'), tool: z.string() }),
  z.object({ id: z.string(), kind: z.literal('tool-not-used'), tool: z.string() }),
  z.object({ id: z.string(), kind: z.literal('first-tool-is'), tool: z.string() }),
  z.object({
    id: z.string(),
    kind: z.literal('tool-arg-matches'),
    tool: z.string(),
    arg: z.string(),
    pattern: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('tool-arg-not-matches'),
    tool: z.string(),
    arg: z.string(),
    pattern: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('before-tool-matches'),
    tools: z.array(z.string()).min(1),
    pattern: z.string(),
  }),
  z.object({ id: z.string(), kind: z.literal('final-matches'), pattern: z.string() }),
  z.object({ id: z.string(), kind: z.literal('final-not-matches'), pattern: z.string() }),
  z.object({ id: z.string(), kind: z.literal('final-max-chars'), max: z.number().positive() }),
  z.object({ id: z.string(), kind: z.literal('final-min-chars'), min: z.number().positive() }),
  z.object({ id: z.string(), kind: z.literal('max-tool-calls'), max: z.number().nonnegative() }),
  z.object({ id: z.string(), kind: z.literal('shell'), command: z.string() }),
])

const steerTaskSchema: z.ZodType<SteerEvalTask> = z.object({
  id: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  fixture: z.string().optional(),
  gitInit: z
    .object({
      defaultBranch: z.string(),
      stageFixture: z.boolean().optional(),
      checkoutBranch: z.string().optional(),
    })
    .optional(),
  allowedCommands: z.array(z.string()).optional(),
  allowedCommandPatterns: z.array(z.string()).optional(),
  mockOnly: z.boolean().optional(),
  excludeTools: z.array(z.string()).optional(),
  checks: z.array(steerCheckSchema).min(1),
  maxSteps: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

const steerSpecSchema: z.ZodType<SteerSpec> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('section'), ref: z.enum(PROMPT_SECTION_IDS) }),
  z.object({
    kind: z.literal('block'),
    ref: z.enum(STEER_BLOCK_IDS),
  }),
  z.object({
    kind: z.literal('turnStart'),
    ref: z.enum(STEER_TURN_START_IDS),
  }),
  z.object({
    kind: z.literal('nudge'),
    ref: z.enum(STEER_NUDGE_IDS),
    afterSteps: z.number().int().positive(),
    controlText: z.string().optional(),
  }),
])

const steerPackSchema: z.ZodType<SteerPack> = z.object({
  id: z.string(),
  description: z.string(),
  steer: steerSpecSchema,
  gate: z
    .object({
      minLift: z.number().optional(),
      minWithPassRate: z.number().optional(),
      meanFinalCharsReduction: z.number().optional(),
    })
    .optional(),
  tasks: z.array(steerTaskSchema).min(1),
})

// ---------------------------------------------------------------------------
// Tools
//
// The doctrine harness ships file tools only. Steer evals additionally need git
// (branch safety, commit steering) and a plan tool (forced planning), and they
// need `run_shell` to be able to do the WRONG thing — a model that shells out
// to `git commit` must be observable, or the commit-steering eval cannot fail.
// ---------------------------------------------------------------------------

export const STEER_EVAL_TOOLS: LLMTool[] = [
  {
    name: 'list_dir',
    description: 'List workspace files',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a complete workspace file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
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
    name: 'git_status',
    description: 'Show working tree status',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show unstaged or staged changes',
    parameters: {
      type: 'object',
      properties: { staged: { type: 'boolean' } },
    },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_commit',
    description:
      'Create a commit with a Co-Authored-By: Copse trailer and the models used (local only; does not push)',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'update_todos',
    description:
      'Create or update a structured multi-step plan (use only for complex multi-step work)',
    parameters: {
      type: 'object',
      properties: {
        todos: { type: 'array', items: { type: 'object' } },
        merge: { type: 'boolean' },
      },
      required: ['todos'],
    },
  },
  {
    name: 'run_shell',
    description:
      'Run a shell command for tests, builds, installs, and other tasks not covered by a dedicated tool',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
]

/**
 * Prompt vars for the eval sandbox. Mirrors the doctrine harness so the two
 * read the same, but advertises the git and plan tools this harness registers.
 */
const EVAL_PROMPT_VARS: PromptSectionVars = {
  tools: `- list_dir: List workspace files
- read_file: Read a workspace file
- write_file: Write a complete workspace file
- str_replace: Replace one exact substring in a workspace file`,
  toolTail: `- git_status: Show working tree status
- git_diff: Show unstaged or staged changes
- git_log: Show recent commit history
- git_commit: Create a commit with a Co-Authored-By: Copse trailer and the models used (local only; does not push)
- run_shell: Run a shell command for tests, builds, installs, and other tasks not covered by a dedicated tool (do not use for reading files or searching code)
- update_todos: Create or update a structured multi-step plan (use only for complex multi-step work)`,
  gather:
    'Use the read tools as needed, then finish with a clear written answer in plain language.',
  avoidRepeat: 'Do not re-read the same paths; use run_shell only when validation is needed.',
  understand: 'Read the file first',
  inspectVerb: 'read',
  toolChoice: `- Use read_file and list_dir for workspace inspection, not run_shell
- Use the dedicated file tools for edits
- Use the git_* tools for version control rather than run_shell`,
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

function git(workspace: string, args: string): string {
  const result = spawnSync(`git ${args}`, {
    cwd: workspace,
    shell: true,
    encoding: 'utf8',
    timeout: SHELL_TIMEOUT_MS,
  })
  return `exit=${String(result.status ?? 'timeout')}\n${`${result.stdout}${result.stderr}`.slice(0, MAX_TOOL_OUTPUT)}`
}

function commandAllowed(task: SteerEvalTask, command: string): boolean {
  if ((task.allowedCommands ?? []).includes(command)) return true
  return (task.allowedCommandPatterns ?? []).some((pattern) => new RegExp(pattern).test(command))
}

async function executeTool(
  workspace: string,
  task: SteerEvalTask,
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
  if (name === 'git_status') return git(workspace, 'status --short --branch')
  if (name === 'git_log') return git(workspace, 'log --oneline -20')
  if (name === 'git_diff') {
    return git(workspace, args['staged'] === true ? 'diff --staged' : 'diff')
  }
  if (name === 'git_commit') {
    // Mirrors the shipping tool: stage everything, then commit with the Copse
    // trailer. The trailer is exactly what `run_shell git commit` loses, so the
    // commit-steering eval can assert on it.
    git(workspace, 'add -A')
    const message = stringArg(args, 'message')
    const body = `${message}\n\nCo-Authored-By: Copse <noreply@copse.dev>`
    return git(workspace, `commit -m ${JSON.stringify(body)}`)
  }
  if (name === 'update_todos') {
    const todos = args['todos']
    const count = Array.isArray(todos) ? todos.length : 0
    return `Recorded a plan with ${String(count)} item(s).`
  }
  if (name === 'run_shell') {
    const command = stringArg(args, 'command')
    if (!commandAllowed(task, command)) {
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

/**
 * Assemble the system prompt for one arm.
 *
 * `section` steers vary by omission (the steer is already part of the base
 * prompt); `block` and `turnStart` steers vary by append, matching how
 * `buildSystemPrompt` and the turn-start hooks add them in production.
 */
export function buildSteerEvalPrompt(
  workspace: string,
  spec: SteerSpec,
  armId: 'with' | 'without',
): string {
  const omit: PromptSectionId[] = spec.kind === 'section' && armId === 'without' ? [spec.ref] : []
  const base = assemblePromptFromSections(buildPromptSections(EVAL_PROMPT_VARS), omit)
    .replace('{WORKSPACE_ROOT}', workspace)
    .replace('{SKILLS_TOOLS_LINE}', '')
  if (armId === 'without') return base
  if (spec.kind === 'block') return `${base}${STEER_BLOCK_TEXTS[spec.ref]}`
  if (spec.kind === 'turnStart') return `${base}\n\n${STEER_TURN_START_TEXTS[spec.ref]}`
  return base
}

/**
 * Parse one pack file. Exported so `npm test` can schema-validate every shipped
 * pack without a model — a typo in a pack is otherwise only discovered when
 * someone starts a long real-model run.
 */
export function loadSteerPack(path: string): SteerPack {
  return steerPackSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

/** Absolute paths of every pack shipped in `benchmarks/steer/packs`. */
export function steerPackPaths(packsDir = 'benchmarks/steer/packs'): string[] {
  return readdirSync(packsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => join(packsDir, file))
}

function loadPacks(options: SteerEvalOptions): SteerPack[] {
  const packs = readdirSync(options.packsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) =>
      steerPackSchema.parse(
        JSON.parse(readFileSync(join(options.packsDir, file), 'utf8')) as unknown,
      ),
    )
    .map((pack) => ({
      ...pack,
      tasks: pack.tasks.filter((task) =>
        options.providerId === 'mock' ? task.mockOnly === true : task.mockOnly !== true,
      ),
    }))
    .filter((pack) => pack.tasks.length > 0)
  return options.packId ? packs.filter((pack) => pack.id === options.packId) : packs
}

function prepareWorkspace(task: SteerEvalTask): string {
  const workspace = mkdtempSync(join(tmpdir(), 'copse-steer-eval-'))
  if (task.fixture) cpSync(resolve(task.fixture), workspace, { recursive: true })
  if (task.gitInit) {
    git(workspace, `init -b ${task.gitInit.defaultBranch}`)
    git(workspace, 'config user.email eval@copse.dev')
    git(workspace, 'config user.name "Copse Eval"')
    // Staging the fixture is the default so the agent sees a normal project
    // with history, rather than a repo where every file is untracked — which
    // is itself a strong behavioural cue and would confound the comparison.
    // Tasks that need a dirty tree opt out with `stageFixture: false`.
    if (task.gitInit.stageFixture !== false) git(workspace, 'add -A')
    git(workspace, 'commit --allow-empty -m "Initial commit"')
    if (task.gitInit.checkoutBranch) git(workspace, `checkout -b ${task.gitInit.checkoutBranch}`)
  }
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

interface RecordedCall {
  name: string
  args: Record<string, unknown>
  textBeforeCall?: string | undefined
}

function argText(call: RecordedCall, arg: string): string {
  const value = call.args[arg]
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

/** Score one finished attempt against the pack's checks. All must pass. */
export function runChecks(
  checks: readonly SteerCheck[],
  context: {
    calls: readonly RecordedCall[]
    finalMessage: string
    workspace: string
  },
): SteerCheckResult[] {
  const { calls, finalMessage, workspace } = context
  return checks.map((check): SteerCheckResult => {
    const result = (pass: boolean, detail: string): SteerCheckResult => ({
      id: check.id,
      kind: check.kind,
      pass,
      detail,
    })
    if (check.kind === 'tool-used') {
      const used = calls.filter((call) => call.name === check.tool).length
      return result(used > 0, `${check.tool} called ${String(used)}x`)
    }
    if (check.kind === 'tool-not-used') {
      const used = calls.filter((call) => call.name === check.tool).length
      return result(used === 0, `${check.tool} called ${String(used)}x`)
    }
    if (check.kind === 'first-tool-is') {
      const first = calls[0]?.name ?? '(none)'
      return result(first === check.tool, `first tool was ${first}`)
    }
    if (check.kind === 'tool-arg-matches') {
      const pattern = new RegExp(check.pattern)
      const hit = calls.some(
        (call) => call.name === check.tool && pattern.test(argText(call, check.arg)),
      )
      return result(hit, hit ? `matched ${check.pattern}` : `no ${check.tool}.${check.arg} matched`)
    }
    if (check.kind === 'tool-arg-not-matches') {
      const pattern = new RegExp(check.pattern)
      const offender = calls.find(
        (call) => call.name === check.tool && pattern.test(argText(call, check.arg)),
      )
      return result(
        offender === undefined,
        offender
          ? `matched ${check.pattern}: ${argText(offender, check.arg).slice(0, 120)}`
          : 'no match',
      )
    }
    if (check.kind === 'before-tool-matches') {
      const firstTargetCall = calls.find((call) => check.tools.includes(call.name))
      const textBeforeCall = firstTargetCall?.textBeforeCall ?? ''
      const pass = new RegExp(check.pattern, 'i').test(textBeforeCall)
      return result(
        pass,
        firstTargetCall === undefined
          ? `none of these tools were called: ${check.tools.join(', ')}`
          : pass
            ? `text before first ${firstTargetCall.name} call matched`
            : `text before first ${firstTargetCall.name} call missing ${check.pattern}`,
      )
    }
    if (check.kind === 'final-matches') {
      const pass = new RegExp(check.pattern, 'i').test(finalMessage)
      return result(pass, pass ? 'final message matched' : `final message missing ${check.pattern}`)
    }
    if (check.kind === 'final-not-matches') {
      const pass = !new RegExp(check.pattern, 'i').test(finalMessage)
      return result(pass, pass ? 'no match' : `final message matched ${check.pattern}`)
    }
    if (check.kind === 'final-max-chars') {
      return result(
        finalMessage.length <= check.max,
        `${String(finalMessage.length)} chars (max ${String(check.max)})`,
      )
    }
    if (check.kind === 'final-min-chars') {
      return result(
        finalMessage.length >= check.min,
        `${String(finalMessage.length)} chars (min ${String(check.min)})`,
      )
    }
    if (check.kind === 'max-tool-calls') {
      return result(
        calls.length <= check.max,
        `${String(calls.length)} calls (max ${String(check.max)})`,
      )
    }
    const shell = spawnSync(check.command, {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
    })
    const tail = `${shell.stdout}${shell.stderr}`.trim().slice(-300)
    return result(shell.status === 0, `exit=${String(shell.status ?? 'timeout')} ${tail}`.trim())
  })
}

function recordArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  return { ...expectRecord(args) }
}

async function runAttempt(
  pack: SteerPack,
  task: SteerEvalTask,
  armId: 'with' | 'without',
  attempt: number,
  provider: LLMProvider,
  outDir: string,
  keepWorkspace: boolean,
): Promise<SteerEvalAttempt> {
  const workspace = prepareWorkspace(task)
  const tracePath = join(outDir, `${pack.id}--${task.id}--${armId}--${String(attempt)}.jsonl`)
  const traceLines: string[] = []
  const calls: RecordedCall[] = []
  let assistantText = ''
  const usage = { inputTokens: 0, outputTokens: 0, chunks: 0 }
  const messages: LLMMessage[] = [
    { role: 'system', content: buildSteerEvalPrompt(workspace, pack.steer, armId) },
    { role: 'user', content: task.prompt },
  ]
  let error: string | undefined
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)

  const onChunk = (chunk: AgentStreamChunk): void => {
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
    if (chunk.type === 'text') {
      assistantText += chunk.text
    }
    if (chunk.type === 'text_replace') {
      assistantText += `\n${chunk.text}`
    }
    if (chunk.type === 'tool_call') {
      calls.push({
        name: chunk.toolCall.name,
        args: recordArgs(chunk.toolCall.args),
        textBeforeCall: assistantText,
      })
    }
    if (chunk.type === 'usage') {
      usage.chunks += 1
      usage.inputTokens += chunk.inputTokens
      usage.outputTokens += chunk.outputTokens
    }
  }

  const excluded = new Set(task.excludeTools ?? [])
  const tools = STEER_EVAL_TOOLS.filter((tool) => !excluded.has(tool.name))
  const maxSteps = task.maxSteps ?? 16
  try {
    if (pack.steer.kind === 'nudge') {
      // Phase 1 runs both arms identically, up to the point the production
      // guard would fire. Phase 2 is the only difference: the steered arm gets
      // the shipping nudge, the control gets a neutral continuation.
      const { afterSteps } = pack.steer
      await runAgentLoop({
        provider,
        messages,
        tools,
        executeTool: (name, args) => executeTool(workspace, task, name, args),
        signal: controller.signal,
        maxSteps: Math.min(afterSteps, maxSteps),
        onChunk,
      })
      const nudge =
        armId === 'with'
          ? STEER_NUDGE_TEXTS[pack.steer.ref]
          : (pack.steer.controlText ?? DEFAULT_NUDGE_CONTROL_TEXT)
      messages.push({ role: 'user', content: nudge })
      await runAgentLoop({
        provider,
        messages,
        tools,
        executeTool: (name, args) => executeTool(workspace, task, name, args),
        signal: controller.signal,
        maxSteps: Math.max(1, maxSteps - afterSteps),
        onChunk,
      })
    } else {
      await runAgentLoop({
        provider,
        messages,
        tools,
        executeTool: (name, args) => executeTool(workspace, task, name, args),
        signal: controller.signal,
        maxSteps,
        onChunk,
      })
    }
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
  const checks = runChecks(task.checks, {
    calls,
    finalMessage,
    workspace,
  })
  writeFileSync(tracePath, `${traceLines.join('\n')}\n`, 'utf8')
  if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true })

  return {
    packId: pack.id,
    taskId: task.id,
    armId,
    attempt,
    compliant: checks.every((check) => check.pass) && error === undefined,
    checks,
    toolNames: calls.map((call) => call.name),
    finalMessage,
    finalChars: finalMessage.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usageEstimated,
    durationMs: Date.now() - started,
    trace: tracePath,
    ...(error !== undefined ? { error } : {}),
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(3))
}

function summarizeArm(
  attempts: readonly SteerEvalAttempt[],
  armId: 'with' | 'without',
): SteerEvalArmSummary {
  const arm = attempts.filter((a) => a.armId === armId)
  const perCheck: Record<string, number> = {}
  const checkIds = [...new Set(arm.flatMap((a) => a.checks.map((c) => c.id)))]
  for (const id of checkIds) {
    const relevant = arm.flatMap((a) => a.checks.filter((c) => c.id === id))
    perCheck[id] = rate(relevant.filter((c) => c.pass).length, relevant.length)
  }
  return {
    armId,
    compliant: arm.filter((a) => a.compliant).length,
    total: arm.length,
    passRate: rate(arm.filter((a) => a.compliant).length, arm.length),
    perCheckPassRate: perCheck,
    meanFinalChars:
      arm.length === 0 ? 0 : Math.round(arm.reduce((sum, a) => sum + a.finalChars, 0) / arm.length),
    inputTokens: arm.reduce((sum, a) => sum + a.inputTokens, 0),
    outputTokens: arm.reduce((sum, a) => sum + a.outputTokens, 0),
  }
}

export function summarizeSteerPack(
  pack: SteerPack,
  attempts: readonly SteerEvalAttempt[],
): SteerEvalPackSummary {
  const withArm = summarizeArm(attempts, 'with')
  const withoutArm = summarizeArm(attempts, 'without')
  const lift = Number((withArm.passRate - withoutArm.passRate).toFixed(3))
  // Positive = the steered arm answered more briefly. Zero when the control
  // produced nothing, so an empty control cannot manufacture a win.
  const meanFinalCharsReduction =
    withoutArm.meanFinalChars === 0
      ? 0
      : Number(
          (
            (withoutArm.meanFinalChars - withArm.meanFinalChars) /
            withoutArm.meanFinalChars
          ).toFixed(3),
        )
  const failures: string[] = []
  if (pack.gate?.minLift !== undefined && lift < pack.gate.minLift) {
    failures.push(`lift ${String(lift)} < minLift ${String(pack.gate.minLift)}`)
  }
  if (pack.gate?.minWithPassRate !== undefined && withArm.passRate < pack.gate.minWithPassRate) {
    failures.push(
      `with-arm pass rate ${String(withArm.passRate)} < minWithPassRate ${String(pack.gate.minWithPassRate)}`,
    )
  }
  if (
    pack.gate?.meanFinalCharsReduction !== undefined &&
    meanFinalCharsReduction < pack.gate.meanFinalCharsReduction
  ) {
    failures.push(
      `mean final-answer length reduction ${String(meanFinalCharsReduction)} < ${String(pack.gate.meanFinalCharsReduction)}`,
    )
  }
  return {
    packId: pack.id,
    description: pack.description,
    steerKind: pack.steer.kind,
    steerRef: pack.steer.ref,
    steerChars: steerText(pack.steer).length,
    arms: [withArm, withoutArm],
    lift,
    meanFinalCharsReduction,
    gatePassed: failures.length === 0,
    gateDetail: failures.length === 0 ? 'ok' : failures.join('; '),
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`
}

export function renderSteerEvalMarkdown(report: SteerEvalReport): string {
  const lines = [
    '# Steer eval',
    '',
    `- provider: \`${report.provider}\` model: \`${report.model}\``,
    `- repeats: ${String(report.repeats)}`,
    `- generated: ${report.generatedAt}`,
    '',
    '`lift` is the steered arm pass rate minus the unsteered arm pass rate. It is the',
    'number that matters: a steer with ~0 lift is not changing behaviour.',
    '',
    '| pack | steer | with | without | lift | len Δ | gate |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const pack of report.packs) {
    const withArm = pack.arms.find((a) => a.armId === 'with')
    const withoutArm = pack.arms.find((a) => a.armId === 'without')
    lines.push(
      `| ${pack.packId} | ${pack.steerKind}:${pack.steerRef} (${String(pack.steerChars)} ch) | ${percent(withArm?.passRate ?? 0)} | ${percent(withoutArm?.passRate ?? 0)} | ${pack.lift >= 0 ? '+' : ''}${percent(pack.lift)} | ${pack.meanFinalCharsReduction >= 0 ? '-' : '+'}${percent(Math.abs(pack.meanFinalCharsReduction))} | ${pack.gatePassed ? 'pass' : `FAIL — ${pack.gateDetail}`} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for this steer eval provider.`)
  return value
}

function buildProvider(options: SteerEvalOptions): { provider: LLMProvider; model: string } {
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
    return { provider: createOpenRouterProvider(model, requiredEnv('OPENROUTER_API_KEY')), model }
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

/** Alternate which arm runs first so provider-side drift cannot favour one arm. */
function orderedArms(taskIndex: number, attempt: number): Array<'with' | 'without'> {
  return (taskIndex + attempt) % 2 === 0 ? ['with', 'without'] : ['without', 'with']
}

export async function runSteerEval(options: SteerEvalOptions): Promise<SteerEvalReport> {
  const packs = loadPacks(options)
  if (packs.length === 0) throw new Error('No steer eval packs matched this provider/pack filter.')
  const { provider, model } = buildProvider(options)
  mkdirSync(options.outDir, { recursive: true })
  const attempts: SteerEvalAttempt[] = []

  console.log(
    `eval:steer provider=${options.providerId} model=${model} packs=${String(packs.length)} repeats=${String(options.repeats)}`,
  )
  for (const pack of packs) {
    for (const [taskIndex, task] of pack.tasks.entries()) {
      for (let attempt = 1; attempt <= options.repeats; attempt += 1) {
        for (const armId of orderedArms(taskIndex, attempt)) {
          const result = await runAttempt(
            pack,
            task,
            armId,
            attempt,
            provider,
            options.outDir,
            options.keepWorkspaces,
          )
          attempts.push(result)
          const failed = result.checks.filter((check) => !check.pass).map((check) => check.id)
          const failedNote = failed.length > 0 ? ` failed=[${failed.join(', ')}]` : ''
          const errorNote = result.error !== undefined ? ` error=${result.error}` : ''
          console.log(
            `  ${result.compliant ? 'PASS' : 'FAIL'} ${pack.id}/${task.id}/${armId}#${String(attempt)}${failedNote}${errorNote}`,
          )
        }
      }
    }
  }

  const report: SteerEvalReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: options.providerId,
    model,
    repeats: options.repeats,
    packs: packs.map((pack) =>
      summarizeSteerPack(
        pack,
        attempts.filter((a) => a.packId === pack.id),
      ),
    ),
    attempts,
  }

  const reportPath = join(options.outDir, 'report.md')
  writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(reportPath, renderSteerEvalMarkdown(report), 'utf8')
  console.log(renderSteerEvalMarkdown(report))
  console.log(`eval:steer report=${reportPath}`)

  const gateFailures = report.packs.filter((pack) => !pack.gatePassed)
  if (options.requireGates && gateFailures.length > 0) {
    throw new Error(
      `steer eval gates failed: ${gateFailures.map((p) => `${p.packId} (${p.gateDetail})`).join('; ')}`,
    )
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

function parseProvider(value: string | undefined): SteerEvalProviderId {
  const provider = value ?? 'lmstudio'
  const found = STEER_EVAL_PROVIDER_IDS.find((id) => id === provider)
  if (!found) throw new Error(`--provider must be one of: ${STEER_EVAL_PROVIDER_IDS.join(', ')}`)
  return found
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
}

export function parseSteerEvalArgs(args: readonly string[]): SteerEvalOptions {
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
    packsDir: argValue(args, '--packs') ?? 'benchmarks/steer/packs',
    ...(argValue(args, '--pack') !== undefined ? { packId: argValue(args, '--pack') } : {}),
    outDir:
      argValue(args, '--out') ??
      join('bench-results', 'steer', `${stamp}-${providerId}-${safePathPart(model ?? 'default')}`),
    keepWorkspaces: args.includes('--keep-workspaces'),
    requireGates: args.includes('--require-gates'),
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  await runSteerEval(parseSteerEvalArgs(args))
}

if (
  process.argv[1]?.endsWith('steer-eval-lib.mts') ||
  process.argv[1]?.endsWith('steer-eval-lib.cjs')
) {
  main().catch((error: unknown) => {
    console.error(`eval:steer: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
