/** Default LM Studio server URL (OpenAI-compatible /v1 endpoint). */
export const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'

/** Default LM Studio model ids (OpenAI-compatible /v1/models ids). */
export const LM_STUDIO_MODEL_IDS = {
  chat: 'qwen/qwen3.6-35b-a3b',
  smallTasks: 'google/gemma-4-e4b',
  safety: 'qwen/qwen3-4b-2507',
} as const

export const DEFAULT_APP_CHAT_MODEL = `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`

export function lmStudioChatModelValue(modelId: string): string {
  return `lmstudio:${modelId}`
}

/** Settings URL, then eval/tunnel env, then default localhost endpoint. */
export function resolveLocalServerUrl(
  storedUrl: string | undefined | null,
  env: { COPSE_EVAL_LM_STUDIO_URL?: string; LM_STUDIO_BASE_URL?: string } = {},
): string {
  const fromEnv = env.COPSE_EVAL_LM_STUDIO_URL?.trim() || env.LM_STUDIO_BASE_URL?.trim()
  if (fromEnv) return fromEnv
  const stored = storedUrl?.trim()
  if (stored) return stored
  return DEFAULT_LM_STUDIO_URL
}
