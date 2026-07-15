// Capability-tier annotations for the cloud models the app ships — the cloud
// counterpart of the *capability axis* in `local-model-catalog.ts` (see
// docs/plans/model-roles-and-defaults.md). Local models carry objective sizing
// and sourced benchmark scores; the cloud catalog only has pricing/context, so
// this module adds the coarse editorial annotation the routing features need:
// which capability tier a model belongs to.
//
// Tiers are deliberately coarse (fast / balanced / frontier) — a product-level
// judgement of "how capable", not a benchmark fact — so unlike the local
// catalog's scores they need no `source`/`asOf` provenance. Consumers: the
// model classifier (representative model per tier) and the advisor strategy
// (is the advisor actually stronger than the executor?).

import { type TrackedModel } from './model-catalog.ts'

/** Capability tiers, cheapest/fastest first. */
export type ModelTier = 'fast' | 'balanced' | 'frontier'

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, frontier: 2 }

/**
 * Tier annotation for every tracked cloud model. `model-tiers.test.ts` asserts
 * the map covers `TRACKED_MODELS` exactly, so adding a model to the catalog
 * forces an annotation here.
 */
export const CLOUD_MODEL_TIERS: Readonly<Record<TrackedModel, ModelTier>> = {
  'claude-sonnet-4-6': 'balanced',
  'claude-opus-4-8': 'frontier',
  'claude-haiku-4-5': 'fast',
  'gpt-5': 'frontier',
  'gpt-5-mini': 'fast',
  'gpt-4o': 'balanced',
  'gpt-4o-mini': 'fast',
}

const TIER_BY_MODEL: ReadonlyMap<string, ModelTier> = new Map(Object.entries(CLOUD_MODEL_TIERS))

/** Tier for a cloud model id, or null when the model isn't annotated (e.g. local ids). */
export function cloudModelTier(model: string): ModelTier | null {
  return TIER_BY_MODEL.get(model) ?? null
}

/** Negative when `a` is a weaker tier than `b`, zero when equal, positive when stronger. */
export function compareModelTiers(a: ModelTier, b: ModelTier): number {
  return TIER_RANK[a] - TIER_RANK[b]
}

/**
 * Representative tracked model per tier, used when a feature needs *a* model of
 * a given capability rather than the user's pick. Deliberately Anthropic-only
 * for now (the app's default family); mapping to the user's actually-configured
 * providers is a follow-up on issue #557.
 */
export const TIER_REPRESENTATIVE_MODEL: Record<ModelTier, TrackedModel> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  frontier: 'claude-opus-4-8',
}
