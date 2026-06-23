// OpenRouter (https://openrouter.ai) is an OpenAI-compatible aggregator: one API
// key and base URL, many upstream models addressed as `vendor/model`. Copse talks
// to it through `OpenAIProvider` with the base URL below (see create-provider.ts).
//
// Selected models are stored as `openrouter:<modelId>` (mirroring `lmstudio:<id>`)
// so the rest of the app can tell an OpenRouter selection apart from a bare cloud
// model id and strip the prefix before sending it upstream.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_MODEL_PREFIX = 'openrouter:'

export interface OpenRouterModelOption {
  /** Upstream OpenRouter model id, e.g. `anthropic/claude-3.5-sonnet`. */
  id: string
  /** Human label shown in the picker. */
  label: string
}

// Curated shortlist of popular OpenRouter models. OpenRouter exposes hundreds of
// models; rather than dump them all into the picker we surface a handful of common
// ones and let users type any other id via the "Custom OpenRouter model" setting.
export const OPENROUTER_MODELS: readonly OpenRouterModelOption[] = [
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
] as const

export function isOpenRouterModel(model: string): boolean {
  return model.startsWith(OPENROUTER_MODEL_PREFIX)
}

/** Strip the `openrouter:` prefix to get the upstream model id. */
export function openRouterModelId(model: string): string {
  return isOpenRouterModel(model) ? model.slice(OPENROUTER_MODEL_PREFIX.length) : model
}

/** Encode an upstream OpenRouter model id as a Copse model selection. */
export function toOpenRouterModel(id: string): string {
  return `${OPENROUTER_MODEL_PREFIX}${id}`
}

/** Display label for an `openrouter:<id>` selection (curated label or the raw id). */
export function openRouterDisplayLabel(model: string): string {
  const id = openRouterModelId(model)
  return OPENROUTER_MODELS.find((m) => m.id === id)?.label ?? id
}
