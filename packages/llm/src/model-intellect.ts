// The single composite "intellect" axis of the capability catalog: Artificial
// Analysis Intelligence Index measurements for cloud AND local model ids,
// expressed on one permanent canonical scale so numbers, once shown, never
// silently change. Sibling to the per-benchmark axes in `local-model-catalog.ts`
// (which stay authoritative for role-specific ranking); this scalar exists for
// cross-model cost/intellect analysis (`pareto-frontier.ts`).
//
// Why a canonical scale: the index renormalises across versions (v4 swapped in
// harder evals than v3 — every model's number changed), so raw values are only
// comparable within one version. `CANONICAL_INTELLECT_VERSION` is the fixed
// ruler; measurements from other versions are translated onto it via the
// crystallised equating maps in `intellect-equating.ts`, always flagged as
// estimates with the full derivation in `basis`. Data is synced from the
// reviewed file `scripts/data/intellect-scores.json` (`npm run sync:intellect`)
// — measurements are cited facts, never guesses; an absent model means "not
// yet sourced", not zero.

import type { BenchmarkScore } from './local-model-catalog.ts'
import { describeEquating, equateAcrossVersions } from './intellect-equating.ts'
import {
  CANONICAL_INTELLECT_VERSION,
  INTELLECT_ALIASES,
  INTELLECT_ATTRIBUTION,
  INTELLECT_EQUATING_MAPS,
  MODEL_INTELLECT_RAW,
  type IntellectMeasurement,
} from './model-intellect.generated.ts'

export { CANONICAL_INTELLECT_VERSION, INTELLECT_ATTRIBUTION }
export type { IntellectMeasurement }

// Artificial Analysis measures served endpoints, i.e. full-precision weights.
// Carrying that lets `localBenchmarkScore()` adjust a local model's intellect
// down to the quant it actually runs at.
const MEASURED_BITS_PER_WEIGHT = 16

/** One step of a score's derivation, for the "why this number" surface. */
export interface IntellectDerivationStep {
  /** Short label, e.g. "measured", "equated", "quant-adjusted". */
  step: string
  /** The value after this step, on the step's own terms. */
  value: number
  /** Human-readable detail (citation, fit description, penalty applied). */
  detail: string
}

export interface IntellectExplanation {
  modelId: string
  /** Final value on the canonical scale. */
  value: number
  /** The canonical scale the value is expressed on. */
  scale: string
  estimated: boolean
  steps: IntellectDerivationStep[]
}

/**
 * Resolve any id/label form a model appears under (bare catalog id, an alias
 * from the sync data such as an OpenRouter id or ACP picker label, or a
 * provider-prefixed value like `lmstudio:<id>`) to the measurement's catalog
 * id. Null when nothing matches — never a fuzzy guess.
 */
export function resolveIntellectModelId(id: string): string | null {
  if (id in MODEL_INTELLECT_RAW) return id
  const aliased = INTELLECT_ALIASES[id]
  if (aliased !== undefined) return aliased
  const sep = id.indexOf(':')
  if (sep > 0) return resolveIntellectModelId(id.slice(sep + 1))
  return null
}

/**
 * The measurement to derive the canonical score from: the canonical-version
 * entry when one exists, else the entry with a translation path to canonical
 * (fewest hops, then most recent). Null when nothing usable is sourced.
 */
function pickMeasurement(
  modelId: string,
): { measurement: IntellectMeasurement; hops: number } | null {
  const resolved = resolveIntellectModelId(modelId)
  const entries = resolved === null ? undefined : MODEL_INTELLECT_RAW[resolved]
  if (!entries || entries.length === 0) return null
  let best: { measurement: IntellectMeasurement; hops: number } | null = null
  for (const m of entries) {
    const equated = equateAcrossVersions(
      m.value,
      m.indexVersion,
      CANONICAL_INTELLECT_VERSION,
      INTELLECT_EQUATING_MAPS,
    )
    if (!equated) continue
    const hops = equated.hops.length
    if (!best || hops < best.hops || (hops === best.hops && m.asOf > best.measurement.asOf)) {
      best = { measurement: m, hops }
    }
  }
  return best
}

/**
 * The model's intellect score on the canonical scale, or null when no sourced
 * measurement exists (absent means "not yet measured", never zero). A value
 * translated from another index version is flagged `estimated` with the fit
 * derivation in `basis`. Shaped as a {@link BenchmarkScore} so it can ride the
 * catalog's `benchmarks` record and the existing quant-adjustment path.
 */
export function getIntellectScore(modelId: string): BenchmarkScore | null {
  const picked = pickMeasurement(modelId)
  if (!picked) return null
  const { measurement } = picked
  if (measurement.indexVersion === CANONICAL_INTELLECT_VERSION) {
    return {
      value: measurement.value,
      source: measurement.source,
      asOf: measurement.asOf,
      measuredBitsPerWeight: MEASURED_BITS_PER_WEIGHT,
    }
  }
  const equated = equateAcrossVersions(
    measurement.value,
    measurement.indexVersion,
    CANONICAL_INTELLECT_VERSION,
    INTELLECT_EQUATING_MAPS,
  )
  if (!equated) return null
  return {
    value: equated.value,
    source: measurement.source,
    asOf: measurement.asOf,
    measuredBitsPerWeight: MEASURED_BITS_PER_WEIGHT,
    estimated: true,
    basis: describeEquating(equated),
  }
}

/**
 * The full "why this number" derivation for a model's canonical intellect
 * score: measured value + citation, then each translation applied. Null when
 * the model has no sourced measurement. This is the one explanation path the
 * picker tooltip, the frontier panel, and tests all share.
 */
export function explainIntellectScore(modelId: string): IntellectExplanation | null {
  const picked = pickMeasurement(modelId)
  if (!picked) return null
  const { measurement } = picked
  const steps: IntellectDerivationStep[] = [
    {
      step: 'measured',
      value: measurement.value,
      detail: `${String(measurement.value)} on index ${measurement.indexVersion} (${measurement.asOf}) — ${measurement.source}`,
    },
  ]
  let value = measurement.value
  let estimated = false
  if (measurement.indexVersion !== CANONICAL_INTELLECT_VERSION) {
    const equated = equateAcrossVersions(
      value,
      measurement.indexVersion,
      CANONICAL_INTELLECT_VERSION,
      INTELLECT_EQUATING_MAPS,
    )
    if (!equated) return null
    value = equated.value
    estimated = true
    steps.push({ step: 'equated', value, detail: describeEquating(equated) })
  }
  return {
    modelId,
    value,
    scale: `Artificial Analysis Intelligence Index ${CANONICAL_INTELLECT_VERSION} (canonical)`,
    estimated,
    steps,
  }
}
