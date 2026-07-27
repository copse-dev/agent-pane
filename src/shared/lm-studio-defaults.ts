import { firstNonEmptyString } from './unknown-value.ts'

/** Default LM Studio server URL (OpenAI-compatible /v1 endpoint). */
export const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'

/** Default LM Studio model ids (OpenAI-compatible /v1/models ids). */
export const LM_STUDIO_MODEL_IDS = {
  chat: 'qwen/qwen3.6-35b-a3b',
  smallTasks: 'google/gemma-4-e4b',
  safety: 'qwen/qwen3-4b-2507',
} as const

/**
 * Settings / picker sentinel: each new chat window resolves the plan-aware
 * Pareto frontier and routes to the best-value model among configured providers.
 */
export const BEST_VALUE_CHAT_MODEL = 'auto:best-value'

/** Human label for {@link BEST_VALUE_CHAT_MODEL} in pickers and Settings. */
export const BEST_VALUE_CHAT_MODEL_LABEL = 'Best value (plan / price)'

/** Concrete local fallback when best-value resolution finds no routable model. */
export const FALLBACK_APP_CHAT_MODEL = `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`

/**
 * Default chat model setting for new installs / unset `model`. Resolves at
 * thread-open and agent-run time via the value frontier — not a fixed provider.
 */
export const DEFAULT_APP_CHAT_MODEL = BEST_VALUE_CHAT_MODEL

export function isBestValueChatModel(model: string | null | undefined): boolean {
  return model === BEST_VALUE_CHAT_MODEL
}

export function lmStudioChatModelValue(modelId: string): string {
  return `lmstudio:${modelId}`
}

/** Settings URL, then eval/tunnel env, then default localhost endpoint. */
export function resolveLocalServerUrl(
  storedUrl: string | undefined | null,
  env: { COPSE_EVAL_LM_STUDIO_URL?: string; LM_STUDIO_BASE_URL?: string } = {},
): string {
  const fromEnv = firstNonEmptyString(
    env.COPSE_EVAL_LM_STUDIO_URL?.trim(),
    env.LM_STUDIO_BASE_URL?.trim(),
  )
  if (fromEnv) return fromEnv
  const stored = storedUrl?.trim()
  if (stored) return stored
  return DEFAULT_LM_STUDIO_URL
}
