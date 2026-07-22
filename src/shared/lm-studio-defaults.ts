/**
 * Default LM Studio server URL (OpenAI-compatible /v1 endpoint).
 * Use `127.0.0.1` rather than `localhost` so probes skip macOS IPv6 (`::1`)
 * resolution — LM Studio binds IPv4, and a `localhost`→`::1` miss can stall
 * until the model-list timeout (looks like a spinner on Settings → Local models).
 */
export const DEFAULT_LM_STUDIO_URL = 'http://127.0.0.1:1234/v1'

/**
 * Rewrite bare `localhost` to `127.0.0.1` for outbound loopback HTTP.
 * Leaves `*.localhost`, IPv6 literals, and non-loopback hosts untouched.
 */
export function preferIpv4LoopbackUrl(url: string): string {
  return url.replace(/^(https?:\/\/)localhost(?=[:/?#]|$)/i, '$1127.0.0.1')
}

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
