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
