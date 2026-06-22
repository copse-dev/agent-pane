// Public API of the cloud-model catalog (pricing, context windows, max output
// tokens, picker options). Consumed by `estimate-cost.ts`,
// `resolve-context-window.ts`, `model-options.ts`, and `anthropic-provider.ts`.
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
  /** Max output tokens per response (Anthropic `max_tokens`, OpenAI completion cap). */
  maxOutputTokens: number
}

export type CloudModelProvider = 'anthropic' | 'openai'

/**
 * Cloud model ids this app ships. Each id must exist verbatim as a key in
 * LiteLLM's catalog so the sync script can resolve it.
 */
export const DEFAULT_CLOUD_MODEL = 'claude-sonnet-4-6'

export const TRACKED_MODELS = [
  DEFAULT_CLOUD_MODEL,
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'gpt-4o',
  'gpt-4o-mini',
] as const

export type TrackedModel = (typeof TRACKED_MODELS)[number]

// Fallback for Anthropic models we don't have catalog data for (e.g. a snapshot
// id we haven't synced yet). 8192 is the documented floor across the Claude
// Messages API.
const DEFAULT_ANTHROPIC_MAX_OUTPUT = 8192

export { MODEL_CATALOG }

export function getModelInfo(model: string): ModelInfo | null {
  return MODEL_CATALOG[model] ?? null
}

export function inferCloudModelProvider(model: string): CloudModelProvider {
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt')) return 'openai'
  throw new Error(`Unknown cloud model provider for '${model}'`)
}

/** Model picker entries derived from {@link TRACKED_MODELS}. */
export const CLOUD_MODELS: ReadonlyArray<
  readonly [value: TrackedModel, label: string, provider: CloudModelProvider]
> = TRACKED_MODELS.map((id) => [id, id, inferCloudModelProvider(id)] as const)

export function anthropicMaxOutputTokens(model: string): number {
  return getModelInfo(model)?.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT
}
