// Extra OpenAI-compatible cloud providers offered alongside OpenRouter, picked
// for their cheap or free tiers: Mistral (free "Experiment" tier on La
// Plateforme), Google Gemini (free-tier Flash models), and DeepSeek (very cheap
// pay-as-you-go). Each speaks the OpenAI chat API, so — like OpenRouter — it is
// reached through `OpenAIProvider` with a custom base URL (see create-provider.ts).
//
// Selected models are stored as `<prefix><modelId>` (e.g. `gemini:gemini-2.5-flash`),
// mirroring `openrouter:` / `lmstudio:`, so the rest of the app can tell the
// selection apart from a bare cloud model id and strip the prefix before sending
// it upstream. Unlike OpenRouter there is no live free+tool-capable catalog to
// query, so each provider ships a curated shortlist of tool-capable models.

export type ExtraProviderId = 'mistral' | 'gemini' | 'deepseek'

export interface ExtraProviderModel {
  /** Upstream model id sent to the provider. */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** Context window (tokens) used for history trimming. */
  contextWindow: number
}

export interface ExtraProvider {
  id: ExtraProviderId
  /** Human label / picker optgroup heading. */
  label: string
  /** Model-selection prefix, e.g. `mistral:`. */
  prefix: string
  /** OpenAI-compatible base URL the SDK talks to. */
  baseUrl: string
  /** Env var that can also supply the key (mirrored from Settings). */
  envVar: 'MISTRAL_API_KEY' | 'GEMINI_API_KEY' | 'DEEPSEEK_API_KEY'
  /** Settings → API Keys field copy. */
  keyLabel: string
  keyPlaceholder: string
  keyHint: string
  /** Optional key-format prefix, checked before any network call. */
  keyPrefix?: string
  /** Curated, tool-capable model shortlist for the picker. */
  models: readonly ExtraProviderModel[]
}

// Mistral and DeepSeek serve up to 128K context; Gemini Flash serves ~1M.
const MISTRAL_CONTEXT = 128_000
const GEMINI_CONTEXT = 1_048_576
// DeepSeek's API caps context at 64K even though the weights support more.
const DEEPSEEK_CONTEXT = 65_536

export const EXTRA_PROVIDERS: Readonly<Record<ExtraProviderId, ExtraProvider>> = {
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    prefix: 'mistral:',
    baseUrl: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
    keyLabel: 'Mistral API key',
    keyPlaceholder: 'Mistral API key',
    keyHint:
      "For Mistral models on La Plateforme's free Experiment tier. Validated via a free models request.",
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small (free tier)', contextWindow: MISTRAL_CONTEXT },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo (free tier)', contextWindow: MISTRAL_CONTEXT },
      { id: 'mistral-large-latest', label: 'Mistral Large', contextWindow: MISTRAL_CONTEXT },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    prefix: 'gemini:',
    // Google's OpenAI-compatibility layer (accepts an `Authorization: Bearer` key).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
    keyLabel: 'Google Gemini API key',
    keyPlaceholder: 'AIza…',
    keyHint:
      'For Gemini Flash models on the free tier (rate-limited, no card). Get a key at aistudio.google.com.',
    keyPrefix: 'AIza',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite (free tier)', contextWindow: GEMINI_CONTEXT },
    ],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    prefix: 'deepseek:',
    baseUrl: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    keyLabel: 'DeepSeek API key',
    keyPlaceholder: 'sk-…',
    keyHint:
      'For DeepSeek models — very cheap pay-as-you-go, with off-peak discounts. Validated via a free models request.',
    keyPrefix: 'sk-',
    // Only `deepseek-chat` (V3) reliably supports function calling, which this
    // agent needs; `deepseek-reasoner` is intentionally omitted.
    models: [{ id: 'deepseek-chat', label: 'DeepSeek V3 (deepseek-chat)', contextWindow: DEEPSEEK_CONTEXT }],
  },
}

export const EXTRA_PROVIDER_IDS = Object.keys(EXTRA_PROVIDERS) as ExtraProviderId[]

export const EXTRA_PROVIDERS_LIST: readonly ExtraProvider[] = EXTRA_PROVIDER_IDS.map(
  (id) => EXTRA_PROVIDERS[id],
)

/** The provider whose prefix `model` carries, or `null` for any other selection. */
export function extraProviderForModel(model: string): ExtraProvider | null {
  return EXTRA_PROVIDERS_LIST.find((p) => model.startsWith(p.prefix)) ?? null
}

export function isExtraProviderModel(model: string): boolean {
  return extraProviderForModel(model) !== null
}

/** Strip the provider prefix to get the upstream model id. */
export function extraProviderModelId(model: string): string {
  const provider = extraProviderForModel(model)
  return provider ? model.slice(provider.prefix.length) : model
}

/** Encode an upstream model id as a Copse model selection for `providerId`. */
export function toExtraProviderModel(providerId: ExtraProviderId, modelId: string): string {
  return `${EXTRA_PROVIDERS[providerId].prefix}${modelId}`
}

/** Display label for an extra-provider selection (curated label or the raw id). */
export function extraProviderDisplayLabel(model: string): string {
  const provider = extraProviderForModel(model)
  if (!provider) return model
  const id = extraProviderModelId(model)
  return provider.models.find((m) => m.id === id)?.label ?? id
}

/** Context window for an extra-provider selection, or `null` if not recognized. */
export function extraProviderContextWindow(model: string): number | null {
  const provider = extraProviderForModel(model)
  if (!provider) return null
  const id = extraProviderModelId(model)
  return provider.models.find((m) => m.id === id)?.contextWindow ?? null
}
