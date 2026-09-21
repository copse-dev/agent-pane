import type OpenAI from 'openai'

type Message = OpenAI.ChatCompletionMessageParam

/** OpenRouter's Claude extension; ordinary OpenAI-compatible servers must not receive it. */
function markMessage(message: Message): Message {
  if (message.role === 'function') return message
  const content = message.content
  if (typeof content === 'string') {
    if (!content) return message
    const block = {
      type: 'text' as const,
      text: content,
      cache_control: { type: 'ephemeral' as const },
    }
    return {
      ...message,
      content: [block],
    }
  }
  if (!content) return message
  // Only text blocks have a documented cache-control shape on this transport.
  // Keep images/refusals intact and place the boundary on the final text block.
  let index = content.length - 1
  while (index >= 0) {
    const part = content[index]
    if (part?.type === 'text' && part.text.length > 0) break
    index--
  }
  if (index < 0) return message
  const marked = content.map((part, i) =>
    i === index ? { ...part, cache_control: { type: 'ephemeral' as const } } : part,
  )
  // The user union can contain images; the other roles accept only text (and,
  // for assistants, refusals). Narrow each role before replacing its content.
  if (message.role === 'user')
    return { ...message, content: marked.filter((part) => part.type !== 'refusal') }
  if (message.role === 'assistant') {
    return {
      ...message,
      content: marked.filter((part) => part.type === 'text' || part.type === 'refusal'),
    }
  }
  return { ...message, content: marked.filter((part) => part.type === 'text') }
}

/**
 * Cache the stable leading system prompt and the reusable conversation tail.
 * Trailing operator instructions are rebuilt every turn, so caching through
 * them would write a prefix the following request cannot reuse (#1286).
 * The third breakpoint is on the last tool definition in OpenAIProvider.
 */
export function markOpenRouterCacheBreakpoints(messages: Message[]): Message[] {
  const result = [...messages]
  const first = result[0]
  if (first?.role === 'system' || first?.role === 'developer') result[0] = markMessage(first)
  let end = result.length
  while (end > 0) {
    const role = result[end - 1]?.role
    if (role !== 'system' && role !== 'developer') break
    end--
  }
  for (let i = end - 1; i >= 0; i--) {
    const message = result[i]
    if (!message || message.role === 'system' || message.role === 'developer') continue
    const marked = markMessage(message)
    if (marked !== message) {
      result[i] = marked
      break
    }
  }
  return result
}
