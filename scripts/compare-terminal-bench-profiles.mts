import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TERMINAL_BENCH_HELD_OUT_TASKS } from './lib/terminal-bench-ablation.mts'
import { TERMINAL_BENCH_DATASET_DESCRIPTOR } from './lib/terminal-bench-tasks.mts'

const STUDY_MODEL = 'qwen3.6-35b-a3b'
const STUDY_ATTEMPTS = 5

interface Trial {
  taskName: string
  reward: number | undefined
  durationSeconds: number | undefined
  inputTokens: number
  outputTokens: number
  toolCalls: number
  outcome: string
  failureCategory: string | undefined
  model: string | undefined
}

interface ProfileTrials {
  profile: string
  profileHash: string | undefined
  tasks: Trial[]
}

interface ParsedReport {
  datasetIdentity: string
  profiles: ProfileTrials[]
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function numberProperty(value: unknown, key: string): number | undefined {
  const item = property(value, key)
  return typeof item === 'number' && Number.isFinite(item) ? item : undefined
}

function stringProperty(value: unknown, key: string): string | undefined {
  const item = property(value, key)
  return typeof item === 'string' && item ? item : undefined
}

function parseTrial(value: unknown): Trial {
  const taskName = stringProperty(value, 'taskName')
  const outcome = stringProperty(value, 'outcome')
  const inputTokens = numberProperty(value, 'inputTokens')
  const outputTokens = numberProperty(value, 'outputTokens')
  const toolCalls = numberProperty(value, 'toolCalls')
  if (
    !taskName ||
    !outcome ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    toolCalls === undefined
  ) {
    throw new Error('Invalid Terminal-Bench comparison trial.')
  }
  return {
    taskName,
    outcome,
    inputTokens,
    outputTokens,
    toolCalls,
    reward: numberProperty(value, 'reward'),
    durationSeconds: numberProperty(value, 'durationSeconds'),
    failureCategory: stringProperty(value, 'failureCategory'),
    model: stringProperty(value, 'model'),
  }
}

function parseReport(value: unknown): ParsedReport {
  if (property(value, 'schemaVersion') !== 2)
    throw new Error('Comparison reports must use schema v2.')
  const dataset = property(value, 'dataset')
  const datasetId = stringProperty(dataset, 'id')
  const datasetRevision = stringProperty(dataset, 'revision')
  if (!datasetId || !datasetRevision) throw new Error('Comparison report dataset is invalid.')
  const profiles = property(value, 'profiles')
  if (!Array.isArray(profiles)) throw new Error('Comparison report profiles are invalid.')
  return {
    datasetIdentity: `${datasetId}@${datasetRevision}`,
    profiles: profiles.map((entry) => {
      const profile = stringProperty(entry, 'profile')
      const tasks = property(entry, 'tasks')
      if (!profile || !Array.isArray(tasks)) throw new Error('Comparison profile is invalid.')
      return {
        profile,
        profileHash: stringProperty(entry, 'profileHash'),
        tasks: tasks.map(parseTrial),
      }
    }),
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) throw new Error('Median index is unavailable.')
  if (sorted.length % 2 !== 0) return upper
  const lower = sorted[middle - 1]
  if (lower === undefined) throw new Error('Median lower index is unavailable.')
  return (lower + upper) / 2
}

function taskMeans(trials: readonly Trial[]): Map<string, number> {
  const values = new Map<string, number[]>()
  for (const trial of trials) {
    if (trial.reward === undefined) continue
    const current = values.get(trial.taskName) ?? []
    current.push(trial.reward)
    values.set(trial.taskName, current)
  }
  return new Map([...values].map(([task, rewards]) => [task, mean(rewards)]))
}

function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function pairedBootstrap(
  baseline: Map<string, number>,
  candidate: Map<string, number>,
  seed: string,
): { tasks: number; difference: number; lower95: number; upper95: number } {
  const tasks = [...baseline.keys()].filter((task) => candidate.has(task)).sort()
  if (tasks.length === 0) throw new Error('Profiles have no paired task rewards.')
  const differences = tasks.map((task) => {
    const candidateValue = candidate.get(task)
    const baselineValue = baseline.get(task)
    if (candidateValue === undefined || baselineValue === undefined) {
      throw new Error(`Paired task ${task} is missing a reward.`)
    }
    return candidateValue - baselineValue
  })
  const random = seededRandom(seed)
  const samples: number[] = []
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const resample: number[] = []
    for (let index = 0; index < differences.length; index += 1) {
      const difference = differences[Math.floor(random() * differences.length)]
      if (difference === undefined) throw new Error('Bootstrap sample index is unavailable.')
      resample.push(difference)
    }
    samples.push(mean(resample))
  }
  samples.sort((a, b) => a - b)
  const lower95 = samples[Math.floor(samples.length * 0.025)]
  const upper95 = samples[Math.floor(samples.length * 0.975)]
  if (lower95 === undefined || upper95 === undefined) {
    throw new Error('Bootstrap confidence interval is unavailable.')
  }
  return {
    tasks: tasks.length,
    difference: mean(differences),
    lower95,
    upper95,
  }
}

const paths = process.argv.slice(2).filter((argument) => argument !== '--json')
if (paths.length === 0) {
  throw new Error('Pass one or more JSON reports from npm run bench:terminal:report -- --json.')
}

const merged = new Map<string, ProfileTrials>()
const datasetIdentities = new Set<string>()
for (const path of paths) {
  const report = parseReport(JSON.parse(await readFile(path, 'utf8')))
  datasetIdentities.add(report.datasetIdentity)
  const profiles = report.profiles
  for (const profile of profiles) {
    const existing = merged.get(profile.profile)
    if (
      existing?.profileHash &&
      profile.profileHash &&
      existing.profileHash !== profile.profileHash
    ) {
      throw new Error(`Profile ${profile.profile} has inconsistent content hashes.`)
    }
    merged.set(profile.profile, {
      profile: profile.profile,
      profileHash: existing?.profileHash ?? profile.profileHash,
      tasks: [...(existing?.tasks ?? []), ...profile.tasks],
    })
  }
}
const expectedDatasetIdentity = `${TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId}@${TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision}`
if (datasetIdentities.size !== 1 || !datasetIdentities.has(expectedDatasetIdentity)) {
  throw new Error(
    `Comparison requires only the pinned Terminal-Bench 2.1 dataset (${expectedDatasetIdentity}).`,
  )
}

const baseline = merged.get('main-legacy@1')
if (!baseline) throw new Error('Comparison requires the main-legacy@1 baseline.')
const baselineMeans = taskMeans(baseline.tasks)
const baselineSolves = new Set(
  baseline.tasks.filter((trial) => trial.outcome === 'pass').map((trial) => trial.taskName),
).size
const baselineTokens = median(baseline.tasks.map((trial) => trial.inputTokens + trial.outputTokens))
const baselineDuration = median(
  baseline.tasks.flatMap((trial) =>
    trial.durationSeconds === undefined ? [] : [trial.durationSeconds],
  ),
)
const models = new Set(
  [...merged.values()].flatMap((profile) =>
    profile.tasks.flatMap((trial) => (trial.model ? [trial.model] : [])),
  ),
)
if (models.size > 1) {
  throw new Error(`Comparison mixes models: ${[...models].sort().join(', ')}.`)
}

function heldOutComplete(profile: ProfileTrials): boolean {
  const trialsByTask = new Map<string, Trial[]>()
  for (const trial of profile.tasks) {
    const current = trialsByTask.get(trial.taskName) ?? []
    current.push(trial)
    trialsByTask.set(trial.taskName, current)
  }
  return (
    trialsByTask.size === TERMINAL_BENCH_HELD_OUT_TASKS.length &&
    TERMINAL_BENCH_HELD_OUT_TASKS.every(
      (taskName) =>
        trialsByTask.get(taskName)?.filter((trial) => trial.reward !== undefined).length ===
        STUDY_ATTEMPTS,
    )
  )
}

const pinnedModel = models.size === 1 && models.has(STUDY_MODEL)

const summaries = [...merged.values()]
  .sort((a, b) => a.profile.localeCompare(b.profile))
  .map((profile) => {
    const rewards = [...taskMeans(profile.tasks).values()]
    const comparison =
      profile.profile === baseline.profile
        ? undefined
        : pairedBootstrap(
            baselineMeans,
            taskMeans(profile.tasks),
            `${baseline.profile}:${profile.profile}`,
          )
    const solves = new Set(
      profile.tasks.filter((trial) => trial.outcome === 'pass').map((trial) => trial.taskName),
    ).size
    const tokens = median(profile.tasks.map((trial) => trial.inputTokens + trial.outputTokens))
    const duration = median(
      profile.tasks.flatMap((trial) =>
        trial.durationSeconds === undefined ? [] : [trial.durationSeconds],
      ),
    )
    const toolCalls = median(profile.tasks.map((trial) => trial.toolCalls))
    const additionalSolves = solves > baselineSolves
    const complete = heldOutComplete(profile)
    const costWithinLimit =
      additionalSolves ||
      ((baselineTokens === null || tokens === null || tokens <= baselineTokens * 1.25) &&
        (baselineDuration === null || duration === null || duration <= baselineDuration * 1.25))
    return {
      profile: profile.profile,
      profileHash: profile.profileHash ?? null,
      trials: profile.tasks.length,
      tasks: rewards.length,
      macroAverageReward: rewards.length > 0 ? mean(rewards) : null,
      solves,
      medianTokens: tokens,
      medianDurationSeconds: duration,
      medianToolCalls: toolCalls,
      outputFinalizationFailures: profile.tasks.filter(
        (trial) => trial.failureCategory === 'output-finalization',
      ).length,
      validationFailures: profile.tasks.filter(
        (trial) => trial.failureCategory === 'validation-failure',
      ).length,
      timeouts: profile.tasks.filter((trial) => trial.outcome === 'timeout').length,
      comparisonToMain: comparison ?? null,
      heldOutComplete: complete,
      eligibleAsDefault:
        comparison !== undefined &&
        comparison.lower95 > 0 &&
        costWithinLimit &&
        complete &&
        heldOutComplete(baseline) &&
        pinnedModel,
    }
  })

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ schemaVersion: 1, summaries }, null, 2))
} else {
  console.log(
    '| Profile | Trials | Tasks | Macro reward | Solved tasks | Median tokens | Median tools | Median seconds | Output missing | Validation failures | Timeouts | Δ vs main (95% CI) | Default gate |',
  )
  console.log(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  )
  for (const summary of summaries) {
    const comparison = summary.comparisonToMain
    const interval = comparison
      ? `${comparison.difference.toFixed(3)} (${comparison.lower95.toFixed(3)}, ${comparison.upper95.toFixed(3)})`
      : 'baseline'
    console.log(
      `| ${summary.profile} | ${String(summary.trials)} | ${String(summary.tasks)} | ` +
        `${summary.macroAverageReward?.toFixed(3) ?? 'n/a'} | ${String(summary.solves)} | ` +
        `${summary.medianTokens?.toFixed(0) ?? 'n/a'} | ` +
        `${summary.medianToolCalls?.toFixed(0) ?? 'n/a'} | ` +
        `${summary.medianDurationSeconds?.toFixed(0) ?? 'n/a'} | ` +
        `${String(summary.outputFinalizationFailures)} | ${String(summary.validationFailures)} | ` +
        `${String(summary.timeouts)} | ` +
        `${interval} | ` +
        `${summary.eligibleAsDefault ? 'eligible' : 'retain main'} |`,
    )
  }
}
