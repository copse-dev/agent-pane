/**
 * Small, dependency-free statistics for the tuning analyzer. Everything random is
 * driven by an explicit seed so an analysis is reproducible byte for byte.
 */

/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959964
/** Normal quantile for 80% power. */
export const Z_POWER_80 = 0.841621

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** Unbiased sample variance; 0 for fewer than two values. */
export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0
  const centre = mean(values)
  let sum = 0
  for (const value of values) sum += (value - centre) ** 2
  return sum / (values.length - 1)
}

export interface Interval {
  lo: number
  hi: number
}

/** Wilson score interval for `successes` of `n` Bernoulli trials (95% by default). */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = successes / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

/** mulberry32: a tiny seeded generator returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const position = q * (sorted.length - 1)
  const below = Math.floor(position)
  const above = Math.ceil(position)
  const lower = sorted[below] ?? Number.NaN
  const upper = sorted[above] ?? Number.NaN
  return lower + (upper - lower) * (position - below)
}

/** Per-task outcome lists (1 = pass, 0 = fail), one entry per valid rep. */
export type OutcomesByTask = ReadonlyMap<string, readonly number[]>

export interface PairedBootstrapOptions {
  iterations?: number
  seed?: number
  /** Two-sided level, 0.05 gives a 95% interval. */
  alpha?: number
}

export interface PairedBootstrapResult extends Interval {
  /** Mean over tasks of (candidate task rate - baseline task rate), on the observed data. */
  diff: number
  tasks: number
}

/**
 * Bootstrap CI for the difference in pass rate (candidate - baseline), where the
 * unit of replication is the task.
 *
 * Two levels: tasks are resampled with replacement, and within each drawn task each
 * config's reps are resampled with replacement too, so the interval carries both
 * the task-to-task spread and the run-to-run noise. Only tasks present in both
 * configs take part; the caller decides which tasks qualify.
 */
export function pairedBootstrap(
  candidate: OutcomesByTask,
  baseline: OutcomesByTask,
  options: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  const iterations = options.iterations ?? 10_000
  const alpha = options.alpha ?? 0.05
  const random = seededRandom(options.seed ?? 1)
  const tasks: Array<{ a: readonly number[]; b: readonly number[] }> = []
  for (const [task, a] of candidate) {
    const b = baseline.get(task)
    if (b !== undefined && a.length > 0 && b.length > 0) tasks.push({ a, b })
  }
  if (tasks.length === 0) return { diff: Number.NaN, lo: Number.NaN, hi: Number.NaN, tasks: 0 }
  const observed = mean(tasks.map((task) => mean(task.a) - mean(task.b)))
  const resampledMean = (values: readonly number[]): number => {
    let sum = 0
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] ?? 0
    }
    return sum / values.length
  }
  const draws: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[Math.floor(random() * tasks.length)]
      if (task !== undefined) sum += resampledMean(task.a) - resampledMean(task.b)
    }
    draws.push(sum / tasks.length)
  }
  draws.sort((x, y) => x - y)
  return {
    diff: observed,
    lo: quantileSorted(draws, alpha / 2),
    hi: quantileSorted(draws, 1 - alpha / 2),
    tasks: tasks.length,
  }
}
