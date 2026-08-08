// Two complementary "intellect" surfaces live in this module:
//
// 1. The measured composite axis — Artificial Analysis Intelligence Index
//    measurements for cloud AND local model ids, expressed on one permanent
//    canonical scale so numbers, once shown, never silently change. Sibling to
//    the per-benchmark axes in `local-model-catalog.ts` (which stay
//    authoritative for role-specific ranking); this scalar exists for
//    cross-model cost/intellect analysis (`pareto-frontier.ts`).
//
//    Why a canonical scale: the index renormalises across versions (v4 swapped
//    in harder evals than v3 — every model's number changed), so raw values are
//    only comparable within one version. `CANONICAL_INTELLECT_VERSION` is the
//    fixed ruler; measurements from other versions are translated onto it via
//    the crystallised equating maps in `intellect-equating.ts`, always flagged
//    as estimates with the full derivation in `basis`. Data is synced from the
//    reviewed file `scripts/data/intellect-scores.json` (`npm run
//    sync:intellect`) — measurements are cited facts, never guesses; an absent
//    model means "not yet sourced", not zero.
//
// 2. The ranking view over that same axis (`modelIntellect` and the band
//    helpers, below) — consumed by the advisor strategy and the model
//    classifier, which only need "which of these is stronger".
//
//    This used to be a second, independent ordinal scale (a hand-maintained
//    3-12 `MODEL_INTELLECT` map). It was redundant — every tracked model also
//    had a measurement — and the two disagreed on 10 of 12 rank positions,
//    with `gpt-4o` in particular frozen at a value from when it was frontier.

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
import { TRACKED_MODELS, type TrackedModel } from './model-catalog.ts'
import { resolveModelIdForm } from './model-id-forms.ts'

export { CANONICAL_INTELLECT_VERSION, INTELLECT_ATTRIBUTION }
export type { IntellectMeasurement }

/** Every model id carrying at least one sourced measurement. */
export function listIntellectScoredModelIds(): string[] {
  return Object.keys(MODEL_INTELLECT_RAW)
}

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
 * Resolve any id/label form a model appears under to the measurement's catalog
 * id: bare ids, aliases from the sync data (OpenRouter ids, ACP picker
 * labels), and the app's structural wrappers — provider prefixes
 * (`lmstudio:<id>`), ACP agent segments (`acp:<agent>#<model>`), option
 * suffixes (`claude-fable-5[1m]`), and serving-route tags on a vendor path
 * (`MiniMaxAI/MiniMax-M3:novita`). Only wrappers are stripped — the model name
 * itself is never fuzzy-matched. Null when nothing resolves.
 */
export function resolveIntellectModelId(id: string): string | null {
  // The wrapper-peeling order lives in `model-id-forms.ts` so the model-card
  // table unwraps ids exactly the way measurements do.
  return resolveModelIdForm(id, (candidate) =>
    candidate in MODEL_INTELLECT_RAW ? candidate : (INTELLECT_ALIASES[candidate] ?? null),
  )
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

// ---------------------------------------------------------------------------
// The editorial ordinal scale — an open-ended "intellect" annotation for the
// cloud models the app ships (see docs/plans/model-roles-and-defaults.md).
//
// Why a scalar and not named tiers: "frontier" is a moving target — today's
// frontier is next year's mid-tier — so static tier labels rot, and anything
// bound to them drifts. An open-ended ordinal scale avoids the rotation: a new
// frontier model simply *extends the top* (a hypothetical next-generation model
// lands at 10, its successor at 11) and existing entries are never re-numbered.
// Relative comparisons between two annotated models therefore stay correct
// forever, while the bands derived from the distribution (`intellectBand`)
// shift automatically as the scale grows — yesterday's top model demotes itself
// the moment a stronger one is annotated.
//
// Cost is deliberately a SEPARATE axis: pricing lives in `model-catalog.ts`
// (synced from LiteLLM) and must never feed into these numbers. Capability and
// price correlate, but conflating them would break both uses.
//
// The numbers are editorial — a product judgement of "how smart", ordinal not
// linear — so unlike the measured axis above they carry no `source`/`asOf`
// provenance. Consumer: the advisor strategy (is the advisor actually stronger
// than the executor?).

/**
 * Intellect for a model id on the canonical scale, for *ranking* purposes.
 *
 * A thin view over the measurement: the consumers here only need "which of
 * these is stronger", not the citation and derivation `getIntellectScore()`
 * carries. Null when nothing is measured (e.g. a local id) — absent means
 * "unknown", never zero.
 */
export function modelIntellect(model: string): number | null {
  return getIntellectScore(model)?.value ?? null
}

/**
 * The distribution the bands are derived from: every tracked cloud model's
 * intellect. Recomputed from the catalog rather than hand-maintained, so adding
 * a model extends the scale automatically.
 */
export const INTELLECT_SCALE: readonly number[] = TRACKED_MODELS.map(
  (model) => modelIntellect(model) ?? 0,
).filter((value) => value > 0)

/** The top of the annotated scale (rises as new frontier models are added). */
export function topAnnotatedIntellect(scale: readonly number[] = INTELLECT_SCALE): number {
  return Math.max(...scale)
}

export type IntellectBand = 'top' | 'mid' | 'low'

/**
 * Band a value relative to the annotated distribution — never against fixed
 * thresholds, so bands re-derive automatically when the scale extends: `top`
 * is within one point of the current maximum, `low` is below the median, `mid`
 * is the rest. Annotating a stronger model demotes yesterday's top band
 * without touching any stored data.
 */
export function intellectBand(
  value: number,
  scale: readonly number[] = INTELLECT_SCALE,
): IntellectBand {
  if (value >= topAnnotatedIntellect(scale) - 1) return 'top'
  const sorted = [...scale].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  return value < median ? 'low' : 'mid'
}

/**
 * Representative annotated model per band, for features that need *a* model of
 * a given capability rather than the user's pick (e.g. the model classifier's
 * recommendation). Deliberately the app's default (Anthropic) family; mapping
 * to the user's actually-configured providers is a follow-up on issue #557.
 *
 * The picks are static but scale-validated: `model-intellect.test.ts` asserts
 * each entry's intellect still falls in its band, so extending the scale with
 * a stronger model (which demotes yesterday's top band) forces these picks to
 * be revisited rather than silently going stale. Tracking the current-generation
 * flagships (Fable 5 top, Sonnet 5 mid) is exactly that revision: Opus 4.8 and
 * Sonnet 4.6 dropped a band once the newer models extended the scale.
 */
export const BAND_REPRESENTATIVE_MODEL: Record<IntellectBand, TrackedModel> = {
  low: 'claude-haiku-4-5',
  mid: 'claude-sonnet-5',
  top: 'claude-fable-5',
}
