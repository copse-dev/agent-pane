/**
 * Pull the human-readable message out of a provider error string.
 *
 * Provider SDKs (Anthropic / OpenAI) format `APIError.message` as
 * `<status> <raw JSON body>`, e.g.
 * `400 {"type":"error","error":{"message":"…"},"request_id":"…"}`.
 * Surfacing that blob verbatim leaks `request_id`/`type` noise into chat,
 * so extract the nested `error.message` (or top-level `message`) instead.
 */
function extractProviderMessage(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  try {
    const parsed = JSON.parse(s.slice(start)) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const msg = parsed.error?.message ?? parsed.message
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
  } catch {
    return null
  }
  return null
}

/** Map provider / local-model failures to user-facing chat text. */
export function classifyAgentError(err: unknown): string {
  const s = String(err)
  if (s.includes('401') || s.includes('Unauthorized'))
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'
  if (
    s.includes('credit balance is too low') ||
    s.includes('Plans & Billing') ||
    s.includes('insufficient_quota') ||
    s.includes('exceeded your current quota') ||
    s.includes('billing_not_active')
  )
    return 'Your provider account is out of credit. Add funds or update billing in your provider dashboard (Anthropic Console → Plans & Billing, or the OpenAI billing page), then try again.'
  if (s.includes('429') || s.includes('rate_limit'))
    return 'Rate limit reached. Please wait a moment and try again.'
  if (
    s.includes('context_length') ||
    s.includes('context window') ||
    s.includes('tokens to keep from the initial prompt')
  )
    return 'Conversation too long for the loaded model context. Reload the model in LM Studio with a larger context, start a new thread, or use smaller reads.'
  if (s.includes('No user query found in messages') || s.includes('jinja template'))
    return 'The local model prompt template failed after history was trimmed. Reload the model in LM Studio with enough context for the chat template, or use a model with a fixed chat template (e.g. under lmstudio-community).'
  const providerMessage = extractProviderMessage(s)
  if (providerMessage) return `An error occurred: ${providerMessage}`
  return `An error occurred: ${err instanceof Error ? err.message : s}`
}
