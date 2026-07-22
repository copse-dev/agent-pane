import { glob, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TERMINAL_BENCH_TASK_NAMES } from './lib/terminal-bench-tasks.mts'

interface TrialSummary {
  taskName: string
  startedAt: string
  reward: number | undefined
  exceptionType: string | undefined
  durationSeconds: number | undefined
  inputTokens: number
  outputTokens: number
  modelRequests: number
  toolCalls: number
  commandTimeouts: number
  streamCuts: number
  appliedNudges: number
}

interface TraceMetrics {
  inputTokens: number
  outputTokens: number
  modelRequests: number
  toolCalls: number
  commandTimeouts: number
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function lineCount(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim() ? text.trimEnd().split('\n').length : 0
  } catch {
    return 0
  }
}

async function traceMetrics(path: string): Promise<TraceMetrics> {
  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    modelRequests: 0,
    toolCalls: 0,
    commandTimeouts: 0,
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return metrics
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const events = nested(value, 'type') === 'events' ? nested(value, 'events') : [value]
    if (!Array.isArray(events)) continue
    for (const event of events) {
      const type = nested(event, 'type')
      if (type === 'tool_call') metrics.toolCalls += 1
      if (type === 'tool_result' && stringValue(nested(event, 'result'))?.startsWith('exit=124')) {
        metrics.commandTimeouts += 1
      }
      if (type === 'usage') {
        metrics.modelRequests += 1
        metrics.inputTokens += numberValue(nested(event, 'inputTokens')) ?? 0
        metrics.outputTokens += numberValue(nested(event, 'outputTokens')) ?? 0
      }
    }
  }
  return metrics
}

async function parseTrial(path: string): Promise<TrialSummary | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    console.warn(`bench:terminal:report: ignoring unreadable result ${path}: ${String(error)}`)
    return undefined
  }

  const taskName = stringValue(nested(value, 'task_name'))
  const startedAt = stringValue(nested(value, 'started_at'))
  if (!taskName || !startedAt) return undefined
  const finishedAt = stringValue(nested(value, 'finished_at'))
  const startedMs = Date.parse(startedAt)
  const finishedMs = finishedAt ? Date.parse(finishedAt) : Number.NaN
  const durationSeconds =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, (finishedMs - startedMs) / 1_000)
      : undefined
  const metadata = nested(value, 'agent_result', 'metadata')
  const agentDirectory = join(dirname(path), 'agent')
  const trace = await traceMetrics(join(agentDirectory, 'copse-trace.jsonl'))

  return {
    taskName,
    startedAt,
    reward: numberValue(nested(value, 'verifier_result', 'rewards', 'reward')),
    exceptionType: stringValue(nested(value, 'exception_info', 'exception_type')),
    durationSeconds,
    inputTokens: numberValue(nested(value, 'agent_result', 'n_input_tokens')) ?? trace.inputTokens,
    outputTokens:
      numberValue(nested(value, 'agent_result', 'n_output_tokens')) ?? trace.outputTokens,
    modelRequests: numberValue(nested(metadata, 'model_requests')) ?? trace.modelRequests,
    toolCalls: numberValue(nested(metadata, 'tool_calls')) ?? trace.toolCalls,
    commandTimeouts: numberValue(nested(metadata, 'command_timeouts')) ?? trace.commandTimeouts,
    streamCuts: await lineCount(join(agentDirectory, 'stream-stats.jsonl')),
    appliedNudges: await lineCount(join(agentDirectory, 'applied-nudges.jsonl')),
  }
}

function outcome(trial: TrialSummary): 'pass' | 'zero' | 'timeout' | 'invalid' {
  if (trial.exceptionType === 'AgentTimeoutError') return 'timeout'
  if (trial.exceptionType !== undefined) return 'invalid'
  return trial.reward === 1 ? 'pass' : 'zero'
}

const trials: TrialSummary[] = []
for await (const path of glob('bench-results/terminal-bench/*/*/result.json')) {
  const trial = await parseTrial(path)
  if (trial) trials.push(trial)
}

const latestByTask = new Map<string, TrialSummary>()
for (const trial of trials.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
  latestByTask.set(trial.taskName, trial)
}
const latest = [...latestByTask.values()].sort((a, b) => a.taskName.localeCompare(b.taskName))
const valid = latest.filter((trial) => outcome(trial) !== 'invalid')
const counts = {
  expectedTasks: TERMINAL_BENCH_TASK_NAMES.length,
  reachedTasks: latest.length,
  validTasks: valid.length,
  unseenTasks: TERMINAL_BENCH_TASK_NAMES.length - latest.length,
  pass: valid.filter((trial) => outcome(trial) === 'pass').length,
  zero: valid.filter((trial) => outcome(trial) === 'zero').length,
  timeout: valid.filter((trial) => outcome(trial) === 'timeout').length,
  invalid: latest.filter((trial) => outcome(trial) === 'invalid').length,
  streamCuts: valid.reduce((sum, trial) => sum + trial.streamCuts, 0),
  appliedNudges: valid.reduce((sum, trial) => sum + trial.appliedNudges, 0),
  modelRequests: valid.reduce((sum, trial) => sum + trial.modelRequests, 0),
  toolCalls: valid.reduce((sum, trial) => sum + trial.toolCalls, 0),
  commandTimeouts: valid.reduce((sum, trial) => sum + trial.commandTimeouts, 0),
  inputTokens: valid.reduce((sum, trial) => sum + trial.inputTokens, 0),
  outputTokens: valid.reduce((sum, trial) => sum + trial.outputTokens, 0),
}

if (process.argv.slice(2).includes('--json')) {
  console.log(
    JSON.stringify(
      { counts, tasks: latest.map((trial) => ({ ...trial, outcome: outcome(trial) })) },
      null,
      2,
    ),
  )
} else {
  console.log(
    `terminal-bench: ${String(counts.validTasks)}/${String(counts.expectedTasks)} valid; ` +
      `${String(counts.pass)} pass, ${String(counts.zero)} zero, ${String(counts.timeout)} timeout, ` +
      `${String(counts.invalid)} invalid, ${String(counts.unseenTasks)} unseen`,
  )
  console.log(
    `lifecycle: ${String(counts.modelRequests)} model requests, ${String(counts.toolCalls)} tool calls, ` +
      `${String(counts.commandTimeouts)} command timeouts, ${String(counts.streamCuts)} stream cuts, ` +
      `${String(counts.appliedNudges)} applied nudges`,
  )
  console.log('')
  for (const trial of latest) {
    const seconds = trial.durationSeconds === undefined ? '?' : trial.durationSeconds.toFixed(0)
    console.log(
      `${outcome(trial).toUpperCase().padEnd(7)} ${trial.taskName.padEnd(42)} ` +
        `${seconds.padStart(5)}s  llm=${String(trial.modelRequests).padStart(2)} ` +
        `tools=${String(trial.toolCalls).padStart(2)} timeouts=${String(trial.commandTimeouts)} ` +
        `cuts=${String(trial.streamCuts)} nudges=${String(trial.appliedNudges)}`,
    )
  }
}
