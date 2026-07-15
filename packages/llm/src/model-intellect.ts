// An open-ended "intellect" scale for the cloud models the app ships — the
// cloud counterpart of the *capability axis* in `local-model-catalog.ts` (see
// docs/plans/model-roles-and-defaults.md). Local models carry objective sizing
// and sourced benchmark scores; the cloud catalog only has pricing/context, so
// this module adds the capability annotation routing features need.
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
// linear — so unlike the local catalog's benchmark scores they carry no
// `source`/`asOf` provenance. Consumer: the advisor strategy (is the advisor
// actually stronger than the executor?).

import { type TrackedModel } from './model-catalog.ts'

/**
 * Intellect annotation for every tracked cloud model. `model-intellect.test.ts`
 * asserts the map covers `TRACKED_MODELS` exactly, so adding a model to the
 * catalog forces an annotation here. Extend the top for new frontier models;
 * never re-number existing entries.
 */
export const MODEL_INTELLECT: Readonly<Record<TrackedModel, number>> = {
  'gpt-4o-mini': 3,
  'claude-haiku-4-5': 4,
  'gpt-5-mini': 5,
  'gpt-4o': 6,
  'claude-sonnet-4-6': 6,
  'gpt-5': 8,
  'claude-opus-4-8': 9,
}

const INTELLECT_BY_MODEL: ReadonlyMap<string, number> = new Map(Object.entries(MODEL_INTELLECT))

/** Intellect for a cloud model id, or null when the model isn't annotated (e.g. local ids). */
export function modelIntellect(model: string): number | null {
  return INTELLECT_BY_MODEL.get(model) ?? null
}

/** The currently-annotated distribution, for band derivation. */
export const INTELLECT_SCALE: readonly number[] = Object.values(MODEL_INTELLECT)

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
 * be revisited rather than silently going stale.
 */
export const BAND_REPRESENTATIVE_MODEL: Record<IntellectBand, TrackedModel> = {
  low: 'claude-haiku-4-5',
  mid: 'claude-sonnet-4-6',
  top: 'claude-opus-4-8',
}
