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
import { canonicalModelLabel } from './model-label.ts'
// A leaf module — safe here, where importing `extra-providers.ts` for the same
// parsing (→ pareto-frontier.ts → this module) would cycle.
import { parseModelSelection, type ModelNamespace } from './model-selection.ts'

export interface ModelInfo {
  /** USD per million input tokens. */
  inputPricePerMTok: number
  /** USD per million output tokens. */
  outputPricePerMTok: number
  /** USD per million cache-read input tokens (Anthropic prompt caching). */
  cacheReadPricePerMTok?: number
  /** USD per million cache-creation input tokens (Anthropic prompt caching). */
  cacheCreationPricePerMTok?: number
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
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
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

/**
 * Human picker / badge labels for tracked cloud model ids. Values stay as the
 * upstream API id (`claude-sonnet-4-6`); only the display string is friendly
 * (`Claude Sonnet 4.6`), matching OpenRouter / Cursor catalog naming.
 */
export const CLOUD_MODEL_LABELS: { readonly [K in TrackedModel]: string } = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-fable-5': 'Claude Fable 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 mini',
  'gpt-5-nano': 'GPT-5 nano',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o mini',
}

/**
 * Friendly label for a tracked cloud id. An untracked id gets the same house
 * spelling when its name says enough to give it one (`claude-opus-4-7` →
 * "Claude Opus 4.7" — the picker lists agent-supplied ids we don't track), and
 * otherwise falls back to itself.
 */
export function cloudModelDisplayLabel(model: string): string {
  const tracked = TRACKED_MODELS.find((candidate) => candidate === model)
  return tracked === undefined ? canonicalModelLabel(model) : CLOUD_MODEL_LABELS[tracked]
}

/** Model picker entries derived from {@link TRACKED_MODELS}. */
export const CLOUD_MODELS: ReadonlyArray<
  readonly [value: TrackedModel, label: string, provider: CloudModelProvider]
> = TRACKED_MODELS.map((id) => [id, CLOUD_MODEL_LABELS[id], inferCloudModelProvider(id)] as const)

export function anthropicMaxOutputTokens(model: string): number {
  return getModelInfo(model)?.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT
}

/**
 * Model families that accept a `{ role: 'system' }` entry *inside* `messages` —
 * the operator channel for instructions that arrive mid-conversation (steering,
 * hook-injected context). Matched by prefix so dated snapshots and suffixed
 * routing ids resolve too.
 *
 * Anything absent from this list must keep current-turn operator instructions
 * in the leading system prompt; sending a mid-conversation system message to a
 * model that doesn't support it is a 400. Notably `claude-sonnet-4-6` — the
 * default cloud model — does not support it, so leading-system placement is the
 * common path, not an edge case.
 */
const MID_CONVERSATION_SYSTEM_PREFIXES = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-mythos-5',
] as const

/** Whether `model` accepts mid-conversation `{ role: 'system' }` messages. */
export function supportsMidConversationSystem(model: string): boolean {
  return MID_CONVERSATION_SYSTEM_PREFIXES.some((prefix) => model.startsWith(prefix))
}

/** Where current-turn operator instructions belong for one stored model selection. */
export type OperatorInstructionPlacement =
  'trailing-developer' | 'trailing-system' | 'leading-system'

/**
 * Namespaces that put a first-party cloud model id on the wire, so a family
 * check against that id means something.
 *
 * The rest cannot: `lmstudio` serves local weights, where a GGUF may be named
 * after a model it is merely distilled from, and `remote-agent` / `acp` /
 * `plugin-model` hand the turn to something that owns its own prompt.
 */
const CLOUD_ROUTED: ReadonlySet<ModelNamespace> = new Set(['cloud', 'openrouter', 'extra-provider'])

/**
 * Select the strongest operator-instruction channel the resolved model is known
 * to accept.
 *
 * This deliberately keys off the stored selection as well as the model id. An
 * LM Studio / MLX model speaks an OpenAI-compatible transport, but that does not
 * make its chat template accept OpenAI's `developer` role. Local and externally
 * hosted agent namespaces therefore take the conservative leading-system path,
 * even when their model name happens to begin with `gpt` or `claude`.
 */
export function operatorInstructionPlacement(model: string): OperatorInstructionPlacement {
  const selection = parseModelSelection(model)
  if (!CLOUD_ROUTED.has(selection.namespace)) return 'leading-system'
  if (selection.modelId.startsWith('gpt-') && !selection.modelId.startsWith('gpt-oss-')) {
    return 'trailing-developer'
  }
  if (supportsMidConversationSystem(selection.modelId)) return 'trailing-system'
  return 'leading-system'
}

/**
 * Whether `model` resolves to the Claude Opus 5 family.
 *
 * Opus 5's default user-facing responses run longer than other models', and
 * effort tunes how much it thinks rather than how much it says — so the fix is
 * a prompt-side conciseness instruction, not a parameter. Callers use this to
 * gate that instruction to the one family that needs it; everything else keeps
 * the model-agnostic prompt unchanged.
 *
 * Takes a stored model selection, not a bare id: the same Opus 5 reaches this
 * as `claude-opus-5` or `openrouter:anthropic/claude-opus-5` depending on how
 * it was picked, and both must steer the same. Prefix match on the resolved id,
 * so dated snapshots (`claude-opus-5-…`) and an aggregator's variant suffixes
 * (`…claude-opus-5:beta`) resolve too.
 */
export function isOpus5Model(model: string): boolean {
  const selection = parseModelSelection(model)
  return CLOUD_ROUTED.has(selection.namespace) && selection.modelId.startsWith('claude-opus-5')
}
