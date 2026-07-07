// Headless benchmark harness (#752 — docs/plans/industry-benchmarks.md, Phase 2).
//
// Runs SWE-bench-shaped task files through @copse/agent's run-agent-loop with a
// minimal workspace-jailed tool registry, grades each outcome with the task's
// own check (test command or file content), and writes per-task JSONL traces
// plus a summary with the two trend metrics the plan tracks: solve rate and
// tokens per solved task.
//
// This harness deliberately imports ONLY the workspace packages — no Electron,
// no src/main — so it doubles as the external-consumer proof of the
// @copse/agent / @copse/llm package boundary.
//
// Providers: `--mock` uses the deterministic mock LLM (tasks steer it with
// `[[mcp:…]]` directives — harness self-test, CI-viable); otherwise an LM
// Studio endpoint from LM_STUDIO_URL / LM_STUDIO_MODEL / LM_STUDIO_API_KEY,
// mirroring validate:local-agent.
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
import { runAgentLoop } from '../packages/agent/src/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import type { LLMProvider, LLMTool } from '@copse/llm/wire-types.ts'
import { MockLLMProvider } from '@copse/llm/mock-provider.ts'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'

export interface BenchTask {
  id: string
  description?: string
  prompt: string
  /** Directory (repo-relative) copied into a fresh temp workspace; omitted → empty workspace. */
  fixture?: string
  /** Git checkout into the temp workspace (SWE-bench-style tasks). Mutually exclusive with fixture. */
  repo?: { url: string; commit: string }
  /** Shell command run in the workspace before the agent starts (dependency install etc.). */
  setup?: string
  grade:
    | { kind: 'shell'; command: string; applyPatch?: string }
    | { kind: 'file-contains'; path: string; needle: string }
  maxSteps?: number
  timeoutMs?: number
}

export interface TaskResult {
  id: string
  solved: boolean
  gradeDetail: string
  toolCalls: number
  inputTokens: number
  outputTokens: number
  usageEstimated: boolean
  durationMs: number
  trace: string
  error?: string
}

export interface BenchSummary {
  model: string
  tasks: TaskResult[]
  solved: number
  total: number
  /** Output tokens spent per solved task — the plumbing-efficiency trend metric. */
  outputTokensPerSolve: number | null
}

const MAX_TOOL_OUTPUT = 12_000
const SHELL_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 15 * 60_000
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000
const BASELINE_PATH = 'benchmarks/bench-baseline.json'
/** Headroom over the baseline tokens-per-solve before the gate fails (model runs are noisy). */
const TOKENS_PER_SOLVE_HEADROOM = 1.25

/** Per-model baseline entry for the `--gate` ratchet (coverage-baseline.json pattern). */
interface BaselineEntry {
  solved: number
  total: number
  outputTokensPerSolve: number | null
}

const TOOLS: LLMTool[] = [
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
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the workspace root and return its output',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to run' } },
      required: ['command'],
    },
  },
]

function jailPath(workspace: string, path: string): string {
  const absRoot = resolve(workspace)
  const absTarget = resolve(absRoot, path || '.')
  const rel = relative(absRoot, absTarget)
  if (rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside workspace: ${path}`)
  }
  return absTarget
}

async function executeTool(workspace: string, name: string, args: unknown): Promise<string> {
  const a = args as { path?: string; content?: string; command?: string }
  if (name === 'list_dir') {
    const dir = jailPath(workspace, a.path ?? '.')
    return readdirSync(dir)
      .slice(0, 200)
      .map((n) => `${statSync(join(dir, n)).isDirectory() ? 'd' : 'f'} ${n}`)
      .join('\n')
  }
  if (name === 'read_file') {
    const file = jailPath(workspace, a.path ?? '')
    return (await readFile(file, 'utf8')).slice(0, MAX_TOOL_OUTPUT)
  }
  if (name === 'write_file') {
    const file = jailPath(workspace, a.path ?? '')
    const content = a.content ?? ''
    mkdirSync(dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
    return `Wrote ${String(content.length)} chars to ${a.path ?? ''}`
  }
  if (name === 'run_shell') {
    const out = spawnSync(a.command ?? '', {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
    })
    const combined = `${out.stdout}${out.stderr}`.slice(0, MAX_TOOL_OUTPUT)
    return `exit=${String(out.status ?? 'timeout')}\n${combined}`
  }
  throw new Error(`Unknown tool: ${name}`)
}

function grade(task: BenchTask, workspace: string): { solved: boolean; detail: string } {
  if (task.grade.kind === 'shell') {
    // SWE-bench-style grading: the graders' test patch is applied only now, so
    // the agent never sees the reference tests while it works.
    if (task.grade.applyPatch) {
      const patchPath = join(workspace, '.bench-grade.patch')
      writeFileSync(patchPath, task.grade.applyPatch, 'utf8')
      const applied = spawnSync('git', ['apply', patchPath], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: SHELL_TIMEOUT_MS,
      })
      rmSync(patchPath, { force: true })
      if (applied.status !== 0) {
        return {
          solved: false,
          detail: `grade patch failed to apply: ${`${applied.stdout}${applied.stderr}`.trim().slice(-300)}`,
        }
      }
    }
    const out = spawnSync(task.grade.command, {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
    })
    const tail = `${out.stdout}${out.stderr}`.trim().slice(-500)
    return { solved: out.status === 0, detail: `exit=${String(out.status ?? 'timeout')} ${tail}` }
  }
  try {
    const text = readFileSync(jailPath(workspace, task.grade.path), 'utf8')
    const solved = text.includes(task.grade.needle)
    return { solved, detail: solved ? 'needle found' : 'needle missing' }
  } catch (err) {
    return { solved: false, detail: `grade file unreadable: ${String(err)}` }
  }
}

function buildProvider(): { provider: LLMProvider; model: string } {
  if (process.argv.includes('--mock') || process.env['COPSE_BENCH_USE_MOCK'] === '1') {
    return { provider: new MockLLMProvider(), model: 'mock' }
  }
  const url = process.env['LM_STUDIO_URL']?.trim() || 'http://localhost:1234/v1'
  const model = process.env['LM_STUDIO_MODEL']?.trim()
  const apiKey = process.env['LM_STUDIO_API_KEY']?.trim() || process.env['LM_API_TOKEN']?.trim()
  if (!model || !apiKey) {
    console.error(
      'bench:agent needs LM_STUDIO_MODEL and LM_STUDIO_API_KEY (or pass --mock for the deterministic harness self-test).',
    )
    process.exit(2)
  }
  return { provider: createLMStudioProvider(url, model, apiKey), model }
}

function loadTasks(tasksDir: string, only?: string): BenchTask[] {
  const files = readdirSync(tasksDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const tasks = files.map((f) => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')) as BenchTask)
  return only ? tasks.filter((t) => t.id === only) : tasks
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

/** A zeroed unsolved result for tasks that die before the agent runs. */
function preparationFailedResult(task: BenchTask, stage: string, detail: string): TaskResult {
  return {
    id: task.id,
    solved: false,
    gradeDetail: `${stage} failed`,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageEstimated: true,
    durationMs: 0,
    trace: '',
    error: `${stage} failed: ${detail}`,
  }
}

/**
 * Populate the temp workspace: fixture copy, pinned-commit git checkout
 * (SWE-bench-style tasks; shallow-fetch so big repos don't pull full history),
 * then the task's setup command. Returns a failure result or null on success.
 */
function prepareWorkspace(task: BenchTask, workspace: string): TaskResult | null {
  if (task.fixture) cpSync(resolve(task.fixture), workspace, { recursive: true })
  if (task.repo) {
    // GitHub allows fetching an arbitrary full SHA at depth 1, so the checkout
    // stays O(tree) instead of O(history) even for SWE-bench-sized repos.
    const gitSteps: string[][] = [
      ['init', '-q', '.'],
      ['remote', 'add', 'origin', task.repo.url],
      ['fetch', '-q', '--depth', '1', 'origin', task.repo.commit],
      ['checkout', '-q', 'FETCH_HEAD'],
    ]
    for (const args of gitSteps) {
      const step = spawnSync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: SETUP_TIMEOUT_MS,
      })
      if (step.status !== 0) {
        const detail = `git ${args[0] ?? ''}: ${`${step.stdout}${step.stderr}`.trim().slice(-500)}`
        return preparationFailedResult(task, 'checkout', detail)
      }
    }
  }
  if (task.setup) {
    const setup = spawnSync(task.setup, {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      timeout: SETUP_TIMEOUT_MS,
    })
    if (setup.status !== 0) {
      const detail = `${setup.stdout}${setup.stderr}`.trim().slice(-500)
      return preparationFailedResult(task, 'setup', detail)
    }
  }
  return null
}

async function runTask(
  task: BenchTask,
  provider: LLMProvider,
  outDir: string,
): Promise<TaskResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'copse-bench-'))
  const preparationFailure = prepareWorkspace(task, workspace)
  if (preparationFailure) {
    rmSync(workspace, { recursive: true, force: true })
    return preparationFailure
  }

  const tracePath = join(outDir, `${task.id}.jsonl`)
  const traceLines: string[] = []
  let textBuffer = ''
  const flushText = (): void => {
    if (!textBuffer) return
    traceLines.push(JSON.stringify({ type: 'text', text: textBuffer }))
    textBuffer = ''
  }

  const stats = { toolCalls: 0, inputTokens: 0, outputTokens: 0, usageChunks: 0 }
  let error: string | undefined
  const started = Date.now()

  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a coding agent working in a repository. Use the tools to inspect and edit files, run tests with run_shell, and keep going until the task is done. Then summarize what you changed in plain text.',
    },
    { role: 'user' as const, content: task.prompt },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)

  try {
    await runAgentLoop({
      provider,
      messages,
      tools: TOOLS,
      executeTool: (name, args) => executeTool(workspace, name, args),
      signal: controller.signal,
      maxSteps: task.maxSteps ?? 20,
      onChunk: (c: AgentStreamChunk) => {
        if (c.type === 'text') {
          textBuffer += c.text
          return
        }
        flushText()
        if (c.type === 'tool_call') stats.toolCalls += 1
        if (c.type === 'usage') {
          stats.usageChunks += 1
          stats.inputTokens += c.inputTokens
          stats.outputTokens += c.outputTokens
        }
        if (c.type === 'tool_call' || c.type === 'tool_result' || c.type === 'done') {
          traceLines.push(JSON.stringify(c))
        }
      },
    })
  } catch (err) {
    error = String(err)
  } finally {
    clearTimeout(timer)
  }
  flushText()

  // Providers that never emit usage chunks (e.g. the mock) still get a rough
  // ~4 chars/token figure so tokens-per-solve stays comparable run to run.
  const usageEstimated = stats.usageChunks === 0
  if (usageEstimated) {
    stats.outputTokens = Math.round(traceLines.join('').length / 4)
    stats.inputTokens = Math.round(JSON.stringify(messages).length / 4)
  }

  const verdict = grade(task, workspace)
  await writeFile(tracePath, `${traceLines.join('\n')}\n`, 'utf8')
  if (process.env['COPSE_BENCH_KEEP'] !== '1') rmSync(workspace, { recursive: true, force: true })

  return {
    id: task.id,
    solved: verdict.solved && !error,
    gradeDetail: verdict.detail,
    toolCalls: stats.toolCalls,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    usageEstimated,
    durationMs: Date.now() - started,
    trace: tracePath,
    ...(error !== undefined ? { error } : {}),
  }
}

export async function runBench(): Promise<void> {
  const tasksDir = argValue('--tasks') ?? 'benchmarks/tasks'
  const outDir = argValue('--out') ?? 'bench-results'
  const only = argValue('--task')
  mkdirSync(outDir, { recursive: true })

  const { provider, model } = buildProvider()
  const tasks = loadTasks(tasksDir, only)
  if (tasks.length === 0) {
    console.error(`No tasks found in ${tasksDir}${only ? ` matching id=${only}` : ''}`)
    process.exit(2)
  }

  console.log(`bench:agent model=${model} tasks=${String(tasks.length)}`)
  const results: TaskResult[] = []
  for (const task of tasks) {
    const r = await runTask(task, provider, outDir)
    results.push(r)
    console.log(
      `  ${r.solved ? 'SOLVED' : 'unsolved'} ${r.id} tools=${String(r.toolCalls)} outTok=${String(r.outputTokens)}${r.usageEstimated ? '~' : ''} ${String(r.durationMs)}ms — ${r.gradeDetail.slice(0, 120)}`,
    )
  }

  const solved = results.filter((r) => r.solved).length
  const summary: BenchSummary = {
    model,
    tasks: results,
    solved,
    total: results.length,
    outputTokensPerSolve:
      solved > 0 ? Math.round(results.reduce((sum, r) => sum + r.outputTokens, 0) / solved) : null,
  }
  const summaryPath = join(outDir, 'summary.json')
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(
    `bench:agent done — solved ${String(solved)}/${String(results.length)}, summary at ${summaryPath}`,
  )

  if (process.argv.includes('--require-solved') && solved < results.length) {
    console.error('bench:agent FAIL: --require-solved set and not every task solved.')
    process.exit(1)
  }

  if (process.argv.includes('--update-baseline')) {
    updateBaseline(summary)
    return
  }
  if (process.argv.includes('--gate')) gateAgainstBaseline(summary)
}

function readBaselines(): Record<string, BaselineEntry> {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, BaselineEntry>
  } catch {
    return {}
  }
}

function updateBaseline(summary: BenchSummary): void {
  const baselines = readBaselines()
  baselines[summary.model] = {
    solved: summary.solved,
    total: summary.total,
    outputTokensPerSolve: summary.outputTokensPerSolve,
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baselines, null, 2)}\n`, 'utf8')
  console.log(`bench:agent baseline for '${summary.model}' updated in ${BASELINE_PATH}.`)
}

/**
 * Trend ratchet, coverage-baseline.json style: solve rate must not drop below
 * the committed baseline for this model, and tokens-per-solve must stay within
 * headroom of it. Rebaseline deliberately with `--update-baseline`.
 */
function gateAgainstBaseline(summary: BenchSummary): void {
  const baseline = readBaselines()[summary.model]
  if (!baseline) {
    console.log(
      `bench:agent gate: no baseline for model '${summary.model}' in ${BASELINE_PATH} — run --update-baseline to start one. Not gating.`,
    )
    return
  }
  const failures: string[] = []
  if (summary.total !== baseline.total) {
    failures.push(
      `task count changed (${String(summary.total)} vs baseline ${String(baseline.total)}) — rebaseline after adding/removing tasks`,
    )
  }
  if (summary.solved < baseline.solved) {
    failures.push(`solved ${String(summary.solved)} < baseline ${String(baseline.solved)}`)
  }
  if (
    summary.outputTokensPerSolve != null &&
    baseline.outputTokensPerSolve != null &&
    summary.outputTokensPerSolve > baseline.outputTokensPerSolve * TOKENS_PER_SOLVE_HEADROOM
  ) {
    failures.push(
      `outputTokensPerSolve ${String(summary.outputTokensPerSolve)} > ${String(TOKENS_PER_SOLVE_HEADROOM)}x baseline ${String(baseline.outputTokensPerSolve)}`,
    )
  }
  if (failures.length > 0) {
    console.error(`bench:agent gate FAIL (model '${summary.model}'): ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(`bench:agent gate OK (model '${summary.model}').`)
}

if (require.main === module) {
  runBench().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
