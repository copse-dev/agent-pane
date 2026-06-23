interface ProviderError {
  status?: number
  type?: string
  code?: string
  message?: string
}

/**
 * Parse a provider failure into structured fields.
 *
 * Provider SDKs (Anthropic / OpenAI) format `APIError.message` as
 * `<status> <raw JSON body>`, e.g.
 * `400 {"type":"error","error":{"type":"…","message":"…"},"request_id":"…"}`.
 * Reading the leading status code and the nested `error` object lets callers
 * classify on structured fields instead of substring-matching the whole blob,
 * and lets the fallback surface the provider's own `message` without the
 * `type`/`request_id` noise.
 */
function parseProviderError(err: unknown): ProviderError {
  const raw = err instanceof Error ? err.message : String(err)
  const parsed: ProviderError = {}
  const status = /^\s*(\d{3})\b/.exec(raw)
  if (status) parsed.status = Number(status[1])
  const brace = raw.indexOf('{')
  if (brace !== -1) {
    try {
      const body = JSON.parse(raw.slice(brace)) as Record<string, unknown>
      const detail = (body.error && typeof body.error === 'object' ? body.error : body) as Record<
        string,
        unknown
      >
      if (typeof detail.type === 'string') parsed.type = detail.type
      if (typeof detail.code === 'string') parsed.code = detail.code
      if (typeof detail.message === 'string') parsed.message = detail.message.trim()
    } catch {
      // Not JSON (e.g. local-model / chat-template failures) — leave unset.
    }
  }
  return parsed
}

/** Map provider / local-model failures to user-facing chat text. */
export function classifyAgentError(err: unknown): string {
  const { status, type, code, message } = parseProviderError(err)
  const raw = err instanceof Error ? err.message : String(err)
  const detail = message ?? raw

  if (status === 401 || type === 'authentication_error' || detail.includes('Unauthorized'))
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'

  // OpenAI returns HTTP 429 for both rate limits and exhausted credit, so key
  // out-of-credit off the structured quota signals *before* the 429 check.
  if (status === 402 || code === 'insufficient_quota' || type === 'insufficient_quota')
    return `An error occurred: ${
      message ??
      'Your provider account is out of credit. Add credit or update billing with your provider, then try again.'
    }`

  if (status === 429 || type === 'rate_limit_error' || detail.includes('rate_limit'))
    return 'Rate limit reached. Please wait a moment and try again.'

  if (
    detail.includes('context_length') ||
    detail.includes('context window') ||
    detail.includes('tokens to keep from the initial prompt')
  )
    return 'Conversation too long for the loaded model context. Reload the model in LM Studio with a larger context, start a new thread, or use smaller reads.'

  if (detail.includes('No user query found in messages') || detail.includes('jinja template'))
    return 'The local model prompt template failed after history was trimmed. Reload the model in LM Studio with enough context for the chat template, or use a model with a fixed chat template (e.g. under lmstudio-community).'

  return `An error occurred: ${message ?? raw}`
}
