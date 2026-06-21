/** Map provider / local-model failures to user-facing chat text. */
export function classifyAgentError(err: unknown): string {
  const s = String(err)
  if (s.includes('401') || s.includes('Unauthorized'))
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'
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
  return `An error occurred: ${err instanceof Error ? err.message : s}`
}
