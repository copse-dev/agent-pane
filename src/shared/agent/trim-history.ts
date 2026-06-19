import type { LLMMessage } from '@shared/types'

/** Rough token estimate (~4 chars per token). Good enough for budget trimming. */
export function estimateMessageTokens(messages: LLMMessage[]): number {
  return JSON.stringify(messages).length / 4
}

/** Tokens we aim to keep history under (below the model’s hard context cap). */
export function historyTokenBudget(
  maxContextTokens: number,
  opts?: { reserveTokens?: number; completionReserveTokens?: number },
): number {
  const reserve = opts?.reserveTokens ?? 0
  const completion = opts?.completionReserveTokens ?? 1_024
  const raw = maxContextTokens - reserve - completion
  return Math.max(1, raw)
}

function systemPromptReserve(messages: LLMMessage[]): number {
  const sys = messages[0]
  if (sys?.role !== 'system') return 0
  return estimateMessageTokens([sys])
}

function conversationMessages(messages: LLMMessage[]): LLMMessage[] {
  const start = contentStartIndex(messages)
  return messages.slice(start)
}

function contentStartIndex(messages: LLMMessage[]): number {
  return messages[0]?.role === 'system' ? 1 : 0
}

/** Token budget for non-system messages (matches trimMessagesInPlace). */
export function conversationTokenBudget(
  messages: LLMMessage[],
  maxContextTokens: number,
  opts?: { reserveTokens?: number; completionReserveTokens?: number },
): number {
  const toolAndCompletion = opts?.reserveTokens ?? 0
  const systemReserve = systemPromptReserve(messages)
  return historyTokenBudget(maxContextTokens, {
    reserveTokens: toolAndCompletion + systemReserve,
    ...(opts?.completionReserveTokens !== undefined
      ? { completionReserveTokens: opts.completionReserveTokens }
      : {}),
  })
}

export function estimateConversationTokens(messages: LLMMessage[]): number {
  return estimateMessageTokens(conversationMessages(messages))
}

/** How many messages to remove at `index` (assistant+tool pairs drop together). */
function droppableSpan(messages: LLMMessage[], index: number): number {
  const m = messages[index]
  if (!m || m.role === 'user') return 0
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    const next = messages[index + 1]
    if (next?.role === 'tool') return 2
  }
  return 1
}

function findOldestDroppableIndex(messages: LLMMessage[], minTail: number): number {
  const start = contentStartIndex(messages)
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.role === 'user') continue
    const span = droppableSpan(messages, i)
    if (span === 0) continue
    if (messages.length - span < minTail) return -1
    return i
  }
  return -1
}

/**
 * Drop oldest non-system messages until estimated size fits the budget.
 * Never removes `user` messages — LM Studio Jinja templates require a user query.
 * Mutates `messages` in place (keeps index 0 system prompt when present).
 */
export function trimMessagesInPlace(
  messages: LLMMessage[],
  maxContextTokens: number,
  opts?: {
    reserveTokens?: number
    minTailMessages?: number
    completionReserveTokens?: number
  },
): boolean {
  const minTail = opts?.minTailMessages ?? 5
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, opts)
  let trimmed = false

  while (messages.length > minTail && estimateConversationTokens(messages) > conversationBudget) {
    const dropIndex = findOldestDroppableIndex(messages, minTail)
    if (dropIndex < 0) break
    const span = droppableSpan(messages, dropIndex)
    messages.splice(dropIndex, span)
    trimmed = true
  }

  return trimmed
}

export function trimHistory(
  messages: LLMMessage[],
  maxContextTokens: number,
  opts?: {
    reserveTokens?: number
    minTailMessages?: number
    completionReserveTokens?: number
  },
): { messages: LLMMessage[]; trimmed: boolean } {
  const copy = [...messages]
  const trimmed = trimMessagesInPlace(copy, maxContextTokens, opts)
  return { messages: copy, trimmed }
}
