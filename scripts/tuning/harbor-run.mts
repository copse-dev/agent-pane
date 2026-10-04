/**
 * Launching Harbor with the container agent for one batch of tasks, and reading what a
 * finished job left on disk back into per-trial observations.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { HARBOR_VERSION, TERMINAL_BENCH_DATASET } from '../lib/terminal-bench.mts'
import {
  terminalBenchCanonicalTaskName,
  terminalBenchQualifiedTaskName,
} from '../lib/terminal-bench-tasks.mts'
import { STEP_TIMING_FILE } from '../lib/terminal-bench-step-timing.mts'
import type { HarborTuning } from '../../src/main/services/container-runtime/harbor-tuning.mts'
import { canonicalJson } from './configs.mts'

export const CONTAINER_AGENT = 'benchmarks.terminal_bench.copse_container_agent:CopseContainerAgent'

export interface HarborLaunch {
  command: string
  args: string[]
  /** Only the variables this launch sets or removes (for display); the full env is `env`. */
  setEnv: Record<string, string>
  env: NodeJS.ProcessEnv
}

export interface HarborLaunchInput {
  model: string
  tasks: readonly string[]
  jobName: string
  jobsDir: string
  tuning: HarborTuning
  repoRoot: string
  env: NodeJS.ProcessEnv
}

/**
 * The exact Harbor invocation for one (config, rep) batch. The tuning travels only as
 * `COPSE_HARBOR_TUNING`; the legacy `COPSE_HARBOR_MAX_STEPS` is removed so a stray
 * shell variable cannot change what a config measures.
 */
export function buildHarborLaunch(input: HarborLaunchInput): HarborLaunch {
  const args = [
    '--from',
    `harbor==${HARBOR_VERSION}`,
    'harbor',
    'run',
    '--dataset',
    TERMINAL_BENCH_DATASET,
    '--agent',
    CONTAINER_AGENT,
    '--model',
    input.model,
    '--env',
    'docker',
    '--jobs-dir',
    input.jobsDir,
    '--job-name',
    input.jobName,
    '--n-concurrent',
    '1',
    '--n-attempts',
    '1',
  ]
  for (const task of input.tasks)
    args.push('--include-task-name', terminalBenchQualifiedTaskName(task))
  const pythonPath = input.env['PYTHONPATH']
  const setEnv: Record<string, string> = {
    COPSE_HARBOR_TUNING: canonicalJson(input.tuning),
    LM_STUDIO_MODEL: input.model,
    PYTHONPATH: pythonPath ? `${input.repoRoot}${delimiter}${pythonPath}` : input.repoRoot,
  }
  const env: NodeJS.ProcessEnv = { ...input.env, ...setEnv }
  delete env['COPSE_HARBOR_MAX_STEPS']
  return { command: 'uvx', args, setEnv, env }
}

/** Everything one finished trial left behind that the ledger needs. */
export interface TrialObservation {
  task: string
  trialDir: string
  startedAt: string | null
  finishedAt: string | null
  reward: number | null
  exception: { type: string; message: string } | null
  agentSeconds: number | null
  modelCalls: number | null
  inputTokens: number | null
  outputTokens: number | null
  stopReason: string | null
  denials: number | null
  deferrals: number | null
  promptsAttempted: number | null
  /** Driver logs and stream-cut reasons: the only text scanned for infrastructure faults. */
  logTexts: string[]
  /** The `requested` tuning the run recorded as applied, or null when it left none. */
  appliedRequested: unknown
  appliedFound: boolean
}

const optionalNumber = z.number().nullish()

const harborTrialSchema = z.looseObject({
  task_name: z.string().optional(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  verifier_result: z
    .looseObject({ rewards: z.looseObject({ reward: optionalNumber }).nullish() })
    .nullish(),
  exception_info: z
    .looseObject({
      exception_type: z.string().nullish(),
      exception_message: z.string().nullish(),
    })
    .nullish(),
  agent_result: z
    .looseObject({
      n_input_tokens: optionalNumber,
      n_output_tokens: optionalNumber,
      metadata: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
})

const copseResultSchema = z.looseObject({
  stopReason: z.string().nullish(),
  promptsAttempted: optionalNumber,
  deferrals: z.array(z.unknown()).nullish(),
  denials: z.array(z.unknown()).nullish(),
  usage: z.looseObject({ inputTokens: optionalNumber, outputTokens: optionalNumber }).nullish(),
})

const driverSummarySchema = z.looseObject({ wallMs: optionalNumber, modelCalls: optionalNumber })
const appliedSchema = z.looseObject({ requested: z.unknown() })
const stepTimingLineSchema = z.looseObject({ cutReason: z.string().nullish() })

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function decodeFile<T>(path: string, schema: z.ZodType<T>): T | null {
  const text = readIfPresent(path)
  return text === null ? null : safeJsonParse(text, decodeWithSchema(schema))
}

function cutReasons(path: string): string[] {
  const text = readIfPresent(path)
  if (text === null) return []
  const reasons: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = safeJsonParse(line, decodeWithSchema(stepTimingLineSchema))
    if (record?.cutReason) reasons.push(record.cutReason)
  }
  return reasons
}

function secondsBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : null
}

/** Read one trial directory of a Harbor job; null when it has no readable `result.json`. */
export function observeTrial(trialDir: string): TrialObservation | null {
  const trial = decodeFile(join(trialDir, 'result.json'), harborTrialSchema)
  if (trial?.task_name === undefined) return null
  const agentDir = join(trialDir, 'agent')
  const copse = decodeFile(join(agentDir, 'out', 'result.json'), copseResultSchema)
  const summary = decodeFile(join(agentDir, 'driver-summary.json'), driverSummarySchema)
  const applied = decodeFile(join(agentDir, 'out', 'tuning.applied.json'), appliedSchema)
  const exceptionType = trial.exception_info?.exception_type ?? null
  const startedAt = trial.started_at ?? null
  const finishedAt = trial.finished_at ?? null
  return {
    task: terminalBenchCanonicalTaskName(trial.task_name),
    trialDir,
    startedAt,
    finishedAt,
    reward: trial.verifier_result?.rewards?.reward ?? null,
    exception:
      exceptionType === null
        ? null
        : { type: exceptionType, message: trial.exception_info?.exception_message ?? '' },
    // The driver's own wall clock is the agent's time; fall back to the whole trial.
    agentSeconds:
      summary?.wallMs === undefined || summary.wallMs === null
        ? secondsBetween(startedAt, finishedAt)
        : summary.wallMs / 1000,
    modelCalls: summary?.modelCalls ?? null,
    inputTokens: copse?.usage?.inputTokens ?? trial.agent_result?.n_input_tokens ?? null,
    outputTokens: copse?.usage?.outputTokens ?? trial.agent_result?.n_output_tokens ?? null,
    stopReason: copse?.stopReason ?? null,
    denials: copse?.denials?.length ?? null,
    deferrals: copse?.deferrals?.length ?? null,
    promptsAttempted: copse?.promptsAttempted ?? null,
    logTexts: [
      readIfPresent(join(agentDir, 'driver.stderr.log')) ?? '',
      readIfPresent(join(agentDir, 'driver.stdout.log')) ?? '',
      ...cutReasons(join(agentDir, STEP_TIMING_FILE)),
      trial.exception_info?.exception_message ?? '',
    ],
    appliedRequested: applied?.requested ?? null,
    appliedFound: applied !== null,
  }
}

/** Every trial a job directory holds, keyed by canonical task name (the last wins). */
export function observeJob(jobDir: string): Map<string, TrialObservation> {
  const observations = new Map<string, TrialObservation>()
  if (!existsSync(jobDir)) return observations
  for (const entry of readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const observation = observeTrial(join(jobDir, entry.name))
    if (observation !== null) observations.set(observation.task, observation)
  }
  return observations
}

/** Whether the run recorded applying exactly the tuning it was launched with. */
export function tuningWasApplied(observation: TrialObservation, tuning: HarborTuning): boolean {
  return (
    observation.appliedFound &&
    canonicalJson(observation.appliedRequested) === canonicalJson(tuning)
  )
}

/** Loaded model ids from LM Studio's REST API, or null when it cannot be read. */
export async function loadedLmStudioModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<string[] | null> {
  try {
    const origin = new URL(baseUrl).origin
    const response = await fetchImpl(`${origin}/api/v0/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = decodeWithSchema(
      z.looseObject({
        data: z.array(z.looseObject({ id: z.string(), state: z.string().optional() })),
      }),
    )(await response.json())
    if (body === null) return null
    return body.data.filter((model) => model.state === 'loaded').map((model) => model.id)
  } catch {
    return null
  }
}
