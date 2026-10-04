/**
 * Honest statistics over the trial ledger.
 *
 * - Only valid trials count.
 * - The unit of comparison is the task: reps within a task are averaged first, so a
 *   task that was run more often does not count for more.
 * - The interval is a seeded two-level bootstrap (tasks, then reps within a task), so
 *   it carries the run-to-run noise that makes identical code flip tasks.
 * - A verdict is `better/worse beyond noise` only when the interval excludes zero AND
 *   the effect is larger than the replicate noise floor AND there are enough tasks
 *   with enough reps. Otherwise it says how much more data would settle it.
 */
import { trialPassed, type TrialRecord } from './ledger.mts'
import {
  Z_95,
  Z_POWER_80,
  mean,
  pairedBootstrap,
  sampleVariance,
  wilsonInterval,
  type Interval,
  type OutcomesByTask,
} from './stats.mts'

export type Verdict =
  | 'better beyond noise'
  | 'worse beyond noise'
  | 'no detectable difference'
  | 'underpowered'

export interface AnalysisOptions {
  /** Bootstrap resamples. */
  iterations: number
  seed: number
  /** Fewest tasks (with enough reps in both configs) a verdict may rest on. */
  minTasks: number
  /** Fewest valid reps per task, in each config, for a task to count. */
  minReps: number
  /** The smallest difference in pass rate worth detecting (and worth ruling out). */
  minEffect: number
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  iterations: 10_000,
  seed: 1,
  minTasks: 8,
  minReps: 2,
  minEffect: 0.1,
}

/** Latest valid record per (config, task, rep). */
function validRecords(records: readonly TrialRecord[]): TrialRecord[] {
  const latest = new Map<string, TrialRecord>()
  for (const record of records) {
    if (!record.valid) continue
    latest.set(`${record.config.hash}|${record.task}|${String(record.rep)}`, record)
  }
  return [...latest.values()]
}

/** Per-task pass/fail outcomes (1/0), one per valid rep, for one config. */
export function outcomesByTask(
  records: readonly TrialRecord[],
  configHash: string,
  tasks?: readonly string[],
): Map<string, number[]> {
  const outcomes = new Map<string, number[]>()
  for (const record of validRecords(records)) {
    if (record.config.hash !== configHash) continue
    if (tasks !== undefined && !tasks.includes(record.task)) continue
    const list = outcomes.get(record.task) ?? []
    list.push(trialPassed(record) ? 1 : 0)
    outcomes.set(record.task, list)
  }
  return outcomes
}

export interface TaskSummary {
  task: string
  passes: number
  reps: number
  rate: number
  wilson: Interval
}

export interface ReplicateNoise {
  /** Tasks with at least two valid reps. */
  tasksReplicated: number
  /** Replicated tasks whose reps did not all agree. */
  flippedTasks: number
  /** flippedTasks / tasksReplicated (0 when nothing is replicated). */
  flipShare: number
  /** Mean over replicated tasks of the unbiased per-task pass-rate variance. */
  meanTaskVariance: number
  /**
   * Standard deviation of the difference between two independent replications of the
   * same config's pass rate over its replicated tasks: what two runs of identical code
   * disagree by.
   */
  runToRunSd: number
  /** 95% of such disagreements fall below this. */
  noiseFloor95: number
}

export function replicateNoise(outcomes: OutcomesByTask): ReplicateNoise {
  let tasksReplicated = 0
  let flippedTasks = 0
  const variances: number[] = []
  let varianceOverReps = 0
  for (const values of outcomes.values()) {
    if (values.length < 2) continue
    tasksReplicated += 1
    const variance = sampleVariance(values)
    variances.push(variance)
    varianceOverReps += variance / values.length
    if (new Set(values).size > 1) flippedTasks += 1
  }
  const runToRunSd = tasksReplicated === 0 ? 0 : Math.sqrt(2 * varianceOverReps) / tasksReplicated
  return {
    tasksReplicated,
    flippedTasks,
    flipShare: tasksReplicated === 0 ? 0 : flippedTasks / tasksReplicated,
    meanTaskVariance: variances.length === 0 ? 0 : mean(variances),
    runToRunSd,
    noiseFloor95: Z_95 * runToRunSd,
  }
}

export interface ConfigSummary {
  configId: string
  hash: string
  trials: number
  validTrials: number
  invalidTrials: number
  pooled: { passes: number; n: number; rate: number; wilson: Interval }
  tasks: TaskSummary[]
  meanAgentSeconds: number | null
  meanModelCalls: number | null
  meanTokens: number | null
  noise: ReplicateNoise
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  const present: number[] = []
  for (const value of values) if (value !== null) present.push(value)
  return present.length === 0 ? null : mean(present)
}

export function summarizeConfig(records: readonly TrialRecord[], hash: string): ConfigSummary {
  const own = records.filter((record) => record.config.hash === hash)
  const valid = validRecords(own)
  const outcomes = outcomesByTask(own, hash)
  const tasks: TaskSummary[] = [...outcomes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([task, values]) => {
      const passes = values.reduce((sum, value) => sum + value, 0)
      return {
        task,
        passes,
        reps: values.length,
        rate: passes / values.length,
        wilson: wilsonInterval(passes, values.length),
      }
    })
  const passes = tasks.reduce((sum, task) => sum + task.passes, 0)
  const n = tasks.reduce((sum, task) => sum + task.reps, 0)
  return {
    configId: own.at(-1)?.config.id ?? hash.slice(0, 8),
    hash,
    trials: own.length,
    validTrials: valid.length,
    invalidTrials: own.filter((record) => !record.valid).length,
    pooled: { passes, n, rate: n === 0 ? 0 : passes / n, wilson: wilsonInterval(passes, n) },
    tasks,
    meanAgentSeconds: meanOrNull(valid.map((record) => record.agentSeconds)),
    meanModelCalls: meanOrNull(valid.map((record) => record.modelCalls)),
    meanTokens: meanOrNull(
      valid.map((record) =>
        record.inputTokens === null && record.outputTokens === null
          ? null
          : (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
      ),
    ),
    noise: replicateNoise(outcomes),
  }
}

export interface PairedTaskRow {
  task: string
  candidate: { passes: number; reps: number }
  baseline: { passes: number; reps: number }
  diff: number
}

export interface DataRequirement {
  /** The effect the requirement is stated for. */
  effect: number
  /** Tasks needed at the current reps per task (80% power, 95% two-sided). */
  tasksNeeded: number
  additionalTasks: number
  /** Reps per task needed on the current task count; null when no number of reps can do it. */
  repsPerTaskNeeded: number | null
}

export interface Comparison {
  candidate: string
  baseline: string
  tasksCompared: number
  tasksExcluded: Array<{ task: string; reason: string }>
  meanRepsCandidate: number
  meanRepsBaseline: number
  candidateRate: number
  baselineRate: number
  diff: number
  ci: Interval
  /** SD of the observed difference attributable to rep-to-rep noise alone. */
  noiseSd: number
  /** 95% bound on a difference two identical configs would show on these tasks. */
  noiseFloor95: number
  verdict: Verdict
  reason: string
  requirement: DataRequirement | null
  perTask: PairedTaskRow[]
}

/** What it would take to detect `effect`, from the observed per-task spread. */
export function dataRequirement(
  rows: readonly { diff: number; noiseVarPerRep: number; reps: number }[],
  effect: number,
): DataRequirement | null {
  if (rows.length < 2 || effect <= 0) return null
  const diffs = rows.map((row) => row.diff)
  const sdDiff = Math.sqrt(sampleVariance(diffs))
  const tasksNeeded = Math.max(2, Math.ceil(((Z_95 + Z_POWER_80) * sdDiff) ** 2 / effect ** 2))
  // Split the per-task difference variance into task-to-task and rep noise, then ask
  // how many reps drive the rep noise low enough on the tasks we already have.
  const meanReps = mean(rows.map((row) => row.reps))
  const noiseAtCurrentReps = mean(rows.map((row) => row.noiseVarPerRep / row.reps))
  const between = Math.max(0, sampleVariance(diffs) - noiseAtCurrentReps)
  const targetVariance = (effect / (Z_95 + Z_POWER_80)) ** 2
  const headroom = rows.length * targetVariance - between
  const perRepNoise = noiseAtCurrentReps * meanReps
  const repsPerTaskNeeded = headroom <= 0 ? null : Math.max(1, Math.ceil(perRepNoise / headroom))
  return {
    effect,
    tasksNeeded,
    additionalTasks: Math.max(0, tasksNeeded - rows.length),
    repsPerTaskNeeded,
  }
}

export function compareConfigs(
  records: readonly TrialRecord[],
  candidateHash: string,
  baselineHash: string,
  partial: Partial<AnalysisOptions> & { tasks?: readonly string[] } = {},
): Comparison {
  const options = { ...DEFAULT_ANALYSIS_OPTIONS, ...partial }
  const candidateAll = outcomesByTask(records, candidateHash, partial.tasks)
  const baselineAll = outcomesByTask(records, baselineHash, partial.tasks)
  const candidate = new Map<string, number[]>()
  const baseline = new Map<string, number[]>()
  const tasksExcluded: Array<{ task: string; reason: string }> = []
  const allTasks = new Set([...candidateAll.keys(), ...baselineAll.keys()])
  for (const task of [...allTasks].sort()) {
    const a = candidateAll.get(task) ?? []
    const b = baselineAll.get(task) ?? []
    if (a.length < options.minReps || b.length < options.minReps) {
      tasksExcluded.push({
        task,
        reason: `needs ${String(options.minReps)} valid reps in both configs (has ${String(a.length)} and ${String(b.length)})`,
      })
      continue
    }
    candidate.set(task, a)
    baseline.set(task, b)
  }
  const perTask: PairedTaskRow[] = []
  const requirementRows: Array<{ diff: number; noiseVarPerRep: number; reps: number }> = []
  let noiseVariance = 0
  for (const [task, a] of candidate) {
    const b = baseline.get(task) ?? []
    const passesA = a.reduce((sum, value) => sum + value, 0)
    const passesB = b.reduce((sum, value) => sum + value, 0)
    const diff = passesA / a.length - passesB / b.length
    perTask.push({
      task,
      candidate: { passes: passesA, reps: a.length },
      baseline: { passes: passesB, reps: b.length },
      diff,
    })
    // Under "no difference" both configs share one per-rep variance; pool the estimates.
    const pooled = (sampleVariance(a) + sampleVariance(b)) / 2
    noiseVariance += pooled * (1 / a.length + 1 / b.length)
    requirementRows.push({
      diff,
      noiseVarPerRep: sampleVariance(a) + sampleVariance(b),
      reps: (a.length + b.length) / 2,
    })
  }
  const tasksCompared = perTask.length
  const noiseSd = tasksCompared === 0 ? 0 : Math.sqrt(noiseVariance) / tasksCompared
  const base = {
    candidate: candidateHash,
    baseline: baselineHash,
    tasksCompared,
    tasksExcluded,
    noiseSd,
    noiseFloor95: Z_95 * noiseSd,
    perTask,
  }
  if (tasksCompared === 0) {
    return {
      ...base,
      meanRepsCandidate: 0,
      meanRepsBaseline: 0,
      candidateRate: Number.NaN,
      baselineRate: Number.NaN,
      diff: Number.NaN,
      ci: { lo: Number.NaN, hi: Number.NaN },
      verdict: 'underpowered',
      reason: `no task has ${String(options.minReps)} valid reps in both configs`,
      requirement: null,
    }
  }
  const bootstrap = pairedBootstrap(candidate, baseline, {
    iterations: options.iterations,
    seed: options.seed,
  })
  const requirement = dataRequirement(requirementRows, options.minEffect)
  const ci = { lo: bootstrap.lo, hi: bootstrap.hi }
  const decided = ((): { verdict: Verdict; reason: string } => {
    if (tasksCompared < options.minTasks) {
      return {
        verdict: 'underpowered',
        reason: `only ${String(tasksCompared)} task(s) with >= ${String(options.minReps)} reps in both configs; at least ${String(options.minTasks)} are required`,
      }
    }
    const beyondNoise = Math.abs(bootstrap.diff) > base.noiseFloor95
    if (ci.lo > 0 || ci.hi < 0) {
      if (!beyondNoise) {
        return {
          verdict: 'underpowered',
          reason: `the interval excludes 0 but the difference (${bootstrap.diff.toFixed(3)}) is within the replicate noise floor (${base.noiseFloor95.toFixed(3)})`,
        }
      }
      return ci.lo > 0
        ? {
            verdict: 'better beyond noise',
            reason: 'the interval excludes 0 and exceeds the noise floor',
          }
        : {
            verdict: 'worse beyond noise',
            reason: 'the interval excludes 0 and exceeds the noise floor',
          }
    }
    if (ci.lo > -options.minEffect && ci.hi < options.minEffect) {
      return {
        verdict: 'no detectable difference',
        reason: `the interval rules out differences of ${String(options.minEffect)} or more in either direction`,
      }
    }
    return {
      verdict: 'underpowered',
      reason: `the interval [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] is too wide to exclude 0 or to rule out ${String(options.minEffect)}`,
    }
  })()
  return {
    ...base,
    meanRepsCandidate: mean([...candidate.values()].map((values) => values.length)),
    meanRepsBaseline: mean([...baseline.values()].map((values) => values.length)),
    candidateRate: mean([...candidate.values()].map((values) => mean(values))),
    baselineRate: mean([...baseline.values()].map((values) => mean(values))),
    diff: bootstrap.diff,
    ci,
    ...decided,
    requirement: decided.verdict === 'underpowered' ? requirement : null,
  }
}

export interface LedgerAnalysis {
  configs: ConfigSummary[]
  baseline: string | null
  comparisons: Comparison[]
  options: AnalysisOptions
}

/** Summaries for every config in the ledger, and each against the baseline. */
export function analyzeLedger(
  records: readonly TrialRecord[],
  partial: Partial<AnalysisOptions> & { baselineHash?: string } = {},
): LedgerAnalysis {
  const options = { ...DEFAULT_ANALYSIS_OPTIONS, ...partial }
  const hashes = [...new Set(records.map((record) => record.config.hash))]
  const configs = hashes.map((hash) => summarizeConfig(records, hash))
  const baseline =
    partial.baselineHash ??
    configs.find((config) => config.configId === 'default')?.hash ??
    configs[0]?.hash ??
    null
  const comparisons =
    baseline === null
      ? []
      : configs
          .filter((config) => config.hash !== baseline)
          .map((config) => compareConfigs(records, config.hash, baseline, options))
  return { configs, baseline, comparisons, options }
}

const pct = (value: number): string =>
  Number.isNaN(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`
const interval = (value: Interval): string => `${pct(value.lo)} to ${pct(value.hi)}`
const orDash = (value: number | null, digits = 0): string =>
  value === null ? '-' : value.toFixed(digits)

export function formatComparison(
  comparison: Comparison,
  names: ReadonlyMap<string, string>,
): string {
  const name = (hash: string): string => names.get(hash) ?? hash.slice(0, 8)
  const lines = [
    `### ${name(comparison.candidate)} vs ${name(comparison.baseline)}: ${comparison.verdict}`,
    '',
    `${comparison.reason}.`,
    '',
    `- tasks compared: ${String(comparison.tasksCompared)} (mean reps ${comparison.meanRepsCandidate.toFixed(1)} vs ${comparison.meanRepsBaseline.toFixed(1)})`,
    `- pass rate: ${pct(comparison.candidateRate)} vs ${pct(comparison.baselineRate)}; difference ${pct(comparison.diff)} (95% bootstrap CI ${interval(comparison.ci)})`,
    `- replicate noise floor (95%): ${pct(comparison.noiseFloor95)}`,
  ]
  if (comparison.requirement !== null) {
    const required = comparison.requirement
    lines.push(
      `- to detect a ${pct(required.effect)} difference (80% power): about ${String(required.tasksNeeded)} tasks at the current reps (${String(required.additionalTasks)} more), ` +
        (required.repsPerTaskNeeded === null
          ? 'and more reps on these tasks alone cannot do it'
          : `or ${String(required.repsPerTaskNeeded)} reps per task on these tasks`),
    )
  }
  if (comparison.tasksExcluded.length > 0) {
    lines.push(
      `- excluded: ${comparison.tasksExcluded.map((entry) => `${entry.task} (${entry.reason})`).join('; ')}`,
    )
  }
  lines.push('', '| task | candidate | baseline | diff |', '| --- | --- | --- | --- |')
  for (const row of comparison.perTask) {
    lines.push(
      `| ${row.task} | ${String(row.candidate.passes)}/${String(row.candidate.reps)} | ${String(row.baseline.passes)}/${String(row.baseline.reps)} | ${row.diff >= 0 ? '+' : ''}${row.diff.toFixed(2)} |`,
    )
  }
  return lines.join('\n')
}

export function formatAnalysis(analysis: LedgerAnalysis): string {
  const names = new Map(analysis.configs.map((config) => [config.hash, config.configId]))
  const lines = [
    '## Configs',
    '',
    '| config | valid | invalid | pass rate (Wilson 95%) | mean s | mean calls | mean tokens | tasks flipping |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const config of analysis.configs) {
    lines.push(
      `| ${config.configId}${config.hash === analysis.baseline ? ' (baseline)' : ''} | ${String(config.validTrials)} | ${String(config.invalidTrials)} | ${pct(config.pooled.rate)} (${String(config.pooled.passes)}/${String(config.pooled.n)}; ${interval(config.pooled.wilson)}) | ${orDash(config.meanAgentSeconds)} | ${orDash(config.meanModelCalls, 1)} | ${orDash(config.meanTokens)} | ${String(config.noise.flippedTasks)}/${String(config.noise.tasksReplicated)} (${pct(config.noise.flipShare)}) |`,
    )
  }
  lines.push('', '## Per-task pass rates', '')
  for (const config of analysis.configs) {
    lines.push(
      `**${config.configId}**`,
      '',
      '| task | passes | Wilson 95% |',
      '| --- | --- | --- |',
    )
    for (const task of config.tasks) {
      lines.push(
        `| ${task.task} | ${String(task.passes)}/${String(task.reps)} | ${interval(task.wilson)} |`,
      )
    }
    lines.push('')
  }
  lines.push('## Replicate noise (same config, repeated runs)', '')
  for (const config of analysis.configs) {
    const noise = config.noise
    lines.push(
      `- ${config.configId}: ${String(noise.flippedTasks)} of ${String(noise.tasksReplicated)} replicated tasks flipped; run-to-run SD of the pass rate ${pct(noise.runToRunSd)}; two runs of identical code differ by more than ${pct(noise.noiseFloor95)} about 5% of the time`,
    )
  }
  lines.push('', '## Comparisons against the baseline', '')
  if (analysis.comparisons.length === 0) lines.push('No second config to compare.')
  for (const comparison of analysis.comparisons) {
    lines.push(formatComparison(comparison, names), '')
  }
  return lines.join('\n')
}
