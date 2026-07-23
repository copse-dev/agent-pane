import { glob, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { terminalBenchTrialOutcome } from './lib/terminal-bench-outcome.mts'
import {
  TERMINAL_BENCH_DATASET_DESCRIPTOR,
  TERMINAL_BENCH_TASK_NAMES,
  terminalBenchCanonicalTaskName,
} from './lib/terminal-bench-tasks.mts'
import { readTerminalBenchTrialProfile } from './lib/terminal-bench-trial-profile.mts'

interface TrialSummary {
  profile: string
  profileHash: string | undefined
  model: string | undefined
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
  failureCategory: FailureCategory
}

type FailureCategory =
  'pass' | 'timeout' | 'infrastructure-invalid' | 'output-finalization' | 'validation-failure'

interface TraceMetrics {
  inputTokens: number
  outputTokens: number
  modelRequests: number
  toolCalls: number
  commandTimeouts: number
}

interface ProfileCounts {
  expectedTasks: number
  reachedTasks: number
  validTasks: number
  unseenTasks: number
  pass: number
  zero: number
  timeout: number
  invalid: number
  streamCuts: number
  appliedNudges: number
  modelRequests: number
  toolCalls: number
  commandTimeouts: number
  inputTokens: number
  outputTokens: number
}

interface ProfileSummary {
  profile: string
  profileHash: string | undefined
  counts: ProfileCounts
  macroAverageReward: number | null
  failureCategories: Record<FailureCategory, number>
  models: string[]
  tasks: Array<TrialSummary & { outcome: ReturnType<typeof terminalBenchTrialOutcome> }>
}

async function failureCategory(value: unknown, directory: string): Promise<FailureCategory> {
  const reward = numberValue(nested(value, 'verifier_result', 'rewards', 'reward'))
  const exceptionType = stringValue(nested(value, 'exception_info', 'exception_type'))
  const outcome = terminalBenchTrialOutcome({ reward, exceptionType })
  if (outcome === 'pass') return 'pass'
  if (outcome === 'timeout') return 'timeout'
  if (outcome === 'invalid') return 'infrastructure-invalid'
  const verifierEvidence = (
    await Promise.all(
      ['test-stdout.txt', 'test-stderr.txt'].map(async (name) => {
        try {
          return await readFile(join(directory, 'verifier', name), 'utf8')
        } catch {
          return ''
        }
      }),
    )
  ).join('\n')
  const evidence = `${JSON.stringify(value)}\n${verifierEvidence}`
  return /(?:FileNotFoundError|No such file or directory|(?:required|expected|output|answer|solution)[^\n]{0,100}(?:file|path)[^\n]{0,60}(?:missing|not found|does not exist))/i.test(
    evidence,
  )
    ? 'output-finalization'
    : 'validation-failure'
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

  const rawTaskName = stringValue(nested(value, 'task_name'))
  const taskName = rawTaskName ? terminalBenchCanonicalTaskName(rawTaskName) : undefined
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
  const retainedProfile = await readTerminalBenchTrialProfile(path)
  const agentDirectory = join(dirname(path), 'agent')
  const trace = await traceMetrics(join(agentDirectory, 'copse-trace.jsonl'))

  return {
    profile:
      stringValue(nested(metadata, 'profile')) ?? retainedProfile?.versionedId ?? 'main-legacy@1',
    profileHash: stringValue(nested(metadata, 'profile_hash')) ?? retainedProfile?.contentHash,
    model:
      stringValue(nested(value, 'config', 'model')) ??
      stringValue(nested(value, 'config', 'agent', 'model_name')),
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
    failureCategory: await failureCategory(value, dirname(path)),
  }
}

const trials: TrialSummary[] = []
for await (const path of glob('bench-results/terminal-bench/*/*/result.json')) {
  const trial = await parseTrial(path)
  if (trial) trials.push(trial)
}

function profileSummary(profile: string, selected: TrialSummary[]): ProfileSummary {
  const ordered = selected.sort(
    (a, b) => a.taskName.localeCompare(b.taskName) || a.startedAt.localeCompare(b.startedAt),
  )
  const valid = ordered.filter((trial) => terminalBenchTrialOutcome(trial) !== 'invalid')
  const reachedTasks = new Set(ordered.map((trial) => trial.taskName)).size
  const counts = {
    expectedTasks: TERMINAL_BENCH_TASK_NAMES.length,
    reachedTasks,
    validTasks: valid.length,
    unseenTasks: TERMINAL_BENCH_TASK_NAMES.length - reachedTasks,
    pass: valid.filter((trial) => terminalBenchTrialOutcome(trial) === 'pass').length,
    zero: valid.filter((trial) => terminalBenchTrialOutcome(trial) === 'zero').length,
    timeout: valid.filter((trial) => terminalBenchTrialOutcome(trial) === 'timeout').length,
    invalid: ordered.filter((trial) => terminalBenchTrialOutcome(trial) === 'invalid').length,
    streamCuts: valid.reduce((sum, trial) => sum + trial.streamCuts, 0),
    appliedNudges: valid.reduce((sum, trial) => sum + trial.appliedNudges, 0),
    modelRequests: valid.reduce((sum, trial) => sum + trial.modelRequests, 0),
    toolCalls: valid.reduce((sum, trial) => sum + trial.toolCalls, 0),
    commandTimeouts: valid.reduce((sum, trial) => sum + trial.commandTimeouts, 0),
    inputTokens: valid.reduce((sum, trial) => sum + trial.inputTokens, 0),
    outputTokens: valid.reduce((sum, trial) => sum + trial.outputTokens, 0),
  }
  const rewards = valid.map((trial) => trial.reward).filter((reward) => reward !== undefined)
  return {
    profile,
    profileHash: ordered.find((trial) => trial.profileHash)?.profileHash,
    counts,
    macroAverageReward:
      rewards.length > 0 ? rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length : null,
    failureCategories: {
      pass: ordered.filter((trial) => trial.failureCategory === 'pass').length,
      timeout: ordered.filter((trial) => trial.failureCategory === 'timeout').length,
      'infrastructure-invalid': ordered.filter(
        (trial) => trial.failureCategory === 'infrastructure-invalid',
      ).length,
      'output-finalization': ordered.filter(
        (trial) => trial.failureCategory === 'output-finalization',
      ).length,
      'validation-failure': ordered.filter(
        (trial) => trial.failureCategory === 'validation-failure',
      ).length,
    },
    models: [...new Set(ordered.flatMap((trial) => (trial.model ? [trial.model] : [])))].sort(),
    tasks: ordered.map((trial) => ({ ...trial, outcome: terminalBenchTrialOutcome(trial) })),
  }
}

const profiles = [...new Set(trials.map((trial) => trial.profile))].sort().map((profile) =>
  profileSummary(
    profile,
    trials.filter((trial) => trial.profile === profile),
  ),
)

if (process.argv.slice(2).includes('--json')) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 2,
        dataset: {
          id: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
          version: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetVersion,
          revision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
        },
        profiles,
      },
      null,
      2,
    ),
  )
} else {
  for (const summary of profiles) {
    console.log(
      `terminal-bench ${summary.profile}: ${String(summary.counts.validTasks)} valid trials; ` +
        `${String(summary.counts.pass)} pass, ${String(summary.counts.zero)} zero, ` +
        `${String(summary.counts.timeout)} timeout, ${String(summary.counts.invalid)} invalid`,
    )
    console.log(
      `lifecycle: ${String(summary.counts.modelRequests)} model requests, ` +
        `${String(summary.counts.toolCalls)} tool calls, ` +
        `${String(summary.counts.commandTimeouts)} command timeouts, ` +
        `${String(summary.counts.streamCuts)} stream cuts, ` +
        `${String(summary.counts.appliedNudges)} applied nudges`,
    )
    console.log(
      `failures: ${String(summary.failureCategories['output-finalization'])} output-finalization, ` +
        `${String(summary.failureCategories['validation-failure'])} validation, ` +
        `${String(summary.failureCategories.timeout)} timeout, ` +
        `${String(summary.failureCategories['infrastructure-invalid'])} infrastructure-invalid`,
    )
    console.log('')
    for (const trial of summary.tasks) {
      const seconds = trial.durationSeconds === undefined ? '?' : trial.durationSeconds.toFixed(0)
      console.log(
        `${trial.outcome.toUpperCase().padEnd(7)} ${trial.taskName.padEnd(42)} ` +
          `${seconds.padStart(5)}s  llm=${String(trial.modelRequests).padStart(2)} ` +
          `tools=${String(trial.toolCalls).padStart(2)} timeouts=${String(trial.commandTimeouts)} ` +
          `cuts=${String(trial.streamCuts)} nudges=${String(trial.appliedNudges)}`,
      )
    }
    console.log('')
  }
}
