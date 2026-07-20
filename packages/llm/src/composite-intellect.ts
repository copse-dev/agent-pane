// A crystallised composite capability score derived from the per-benchmark
// axes we already track, for models with NO sourced Intelligence Index
// measurement (most local weights never appear on Artificial Analysis). It
// answers "roughly how capable is this model" from the sourced facts we do
// have, without ever inventing a number.
//
// Stability contract (the point of "crystallised"): the weight table below is
// versioned (`copse-intellect-v1`) and immutable — adding axes or changing
// weights is a deliberate version bump, never a silent drift, so a composite
// value only changes when the model's own sourced measurements change.
//
// SCALE WARNING: this is a weighted mean of 0–100 pass-rate benchmarks, which
// is NOT the Artificial Analysis Intelligence Index scale (a harder composite
// where frontier models sit around 55–60). The two must never be ranked on one
// axis — the Pareto frontier only accepts canonical-scale scores, and this
// module's values are for comparing *composite-scored models with each other*.
// Once any model carries both a composite and a canonical measurement, a
// calibration fit (same machinery as `intellect-equating.ts`) can bridge the
// scales; until then they stay apart.

import {
  localBenchmarkScore,
  type Benchmark,
  type BenchmarkScore,
  type LocalModelCapability,
} from './local-model-catalog.ts'

export const COMPOSITE_INTELLECT_VERSION = 'copse-intellect-v1'

/**
 * Crystallised weights. Only 0–100 pass-rate axes participate: `arena` is an
 * Elo (different units) and `aa-intelligence` is the canonical scale this
 * composite substitutes for. Agentic/repo-level benchmarks weigh more than
 * single-function synthesis, mirroring how the roles registry values them.
 */
export const COMPOSITE_WEIGHTS: Partial<Record<Benchmark, number>> = {
  'swe-bench': 1.5,
  'aider-polyglot': 1.25,
  livecodebench: 1,
  'aider-edit': 1,
  'tau-bench': 1,
  gpqa: 1,
  'humaneval-plus': 0.75,
  'mmlu-pro': 0.75,
  'multipl-e': 0.5,
}

/** Fewer sourced axes than this and a mean is too easily skewed to publish. */
export const MIN_COMPOSITE_AXES = 3

export interface CompositeIntellect {
  /** Weighted mean over the sourced axes, 0–100. NOT the canonical scale. */
  value: number
  /** The crystallised weight-table version that produced the value. */
  version: string
  /** Axes that contributed, in weight order — the coverage disclosure. */
  axes: Benchmark[]
  /** True — a composite is always derived, never a measurement. */
  estimated: true
  /** Full derivation: every axis value (quant-adjusted) and its weight. */
  basis: string
}

/**
 * The composite score for a local model, or null when it has a canonical
 * intellect measurement (the real thing wins) or fewer than
 * {@link MIN_COMPOSITE_AXES} sourced axes. Axis values are quant-adjusted via
 * {@link localBenchmarkScore}, so the composite reflects the model as it runs
 * on-device. Deterministic — same catalog in, same number out.
 */
export function compositeIntellect(model: LocalModelCapability): CompositeIntellect | null {
  if (model.benchmarks['aa-intelligence']) return null
  const parts: Array<{ axis: Benchmark; score: BenchmarkScore; weight: number }> = []
  for (const [axis, weight] of Object.entries(COMPOSITE_WEIGHTS) as Array<[Benchmark, number]>) {
    const score = localBenchmarkScore(model, axis)
    if (score) parts.push({ axis, score, weight })
  }
  if (parts.length < MIN_COMPOSITE_AXES) return null
  parts.sort((a, b) => b.weight - a.weight || a.axis.localeCompare(b.axis))
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0)
  const value = Number(
    (parts.reduce((s, p) => s + p.score.value * p.weight, 0) / totalWeight).toFixed(1),
  )
  const detail = parts
    .map(
      (p) =>
        `${p.axis} ${String(p.score.value)}${p.score.estimated ? ' (est.)' : ''}×${String(p.weight)}`,
    )
    .join(', ')
  return {
    value,
    version: COMPOSITE_INTELLECT_VERSION,
    axes: parts.map((p) => p.axis),
    estimated: true,
    basis: `${COMPOSITE_INTELLECT_VERSION}: weighted mean of ${String(parts.length)}/${String(
      Object.keys(COMPOSITE_WEIGHTS).length,
    )} axes — ${detail}`,
  }
}
