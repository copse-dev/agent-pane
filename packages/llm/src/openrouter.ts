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

// Friendly display labels for a few well-known OpenRouter ids. The picker is
// populated live from OpenRouter's catalog (free, tool-capable models); this map
// only supplies a nicer label than the raw id when one of these is selected.
export const OPENROUTER_MODELS: readonly OpenRouterModelOption[] = [
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'z-ai/glm-4.6', label: 'GLM-4.6' },
  { id: 'z-ai/glm-4.5-air:free', label: 'GLM-4.5 Air (free)' },
  { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B A22B' },
  { id: 'qwen/qwen3-235b-a22b:free', label: 'Qwen3 235B A22B (free)' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1' },
  { id: 'deepseek/deepseek-chat-v3.1:free', label: 'DeepSeek V3.1 (free)' },
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
