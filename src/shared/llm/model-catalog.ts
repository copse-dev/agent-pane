// Public API of the cloud-model catalog (pricing + context windows). Consumed
// by `estimate-cost.ts` and `resolve-context-window.ts`.
//
// The data itself lives in `model-catalog.generated.ts`, which is rewritten by
// `scripts/sync-model-catalog.mts` (and the `Sync model catalog` GitHub
// workflow) from BerriAI/litellm's `model_prices_and_context_window.json`. To
// add or remove a model:
//
//   1. Edit TRACKED_MODELS below.
//   2. Mirror the change in the `TRACKED_MODELS` list in
//      `scripts/sync-model-catalog.mts` (`model-catalog.test.ts` enforces that
//      every TRACKED_MODELS entry actually has catalog data).
//   3. Run `npm run sync:models`.

import { MODEL_CATALOG } from './model-catalog.generated.ts'

export interface ModelInfo {
  /** USD per million input tokens. */
  inputPricePerMTok: number
  /** USD per million output tokens. */
  outputPricePerMTok: number
  /** Max input tokens (context window) at standard pricing. */
  contextWindow: number
}

/**
 * Cloud model ids this app ships. Each id must exist verbatim as a key in
 * LiteLLM's catalog so the sync script can resolve it.
 */
export const TRACKED_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'gpt-4o',
  'gpt-4o-mini',
] as const

export type TrackedModel = (typeof TRACKED_MODELS)[number]

export { MODEL_CATALOG }

export function getModelInfo(model: string): ModelInfo | null {
  return MODEL_CATALOG[model] ?? null
}
