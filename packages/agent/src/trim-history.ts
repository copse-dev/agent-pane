import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'

/** Flat estimate per image block (avoids counting base64 at ~4 chars/token). */
export const ESTIMATED_IMAGE_TOKENS = 1600

export const CANCELLED_TOOL_RESULT = 'Tool execution cancelled.'

let lastMeasuredInputTokens: number | null = null

export function setLastMeasuredInputTokens(tokens: number | null): void {
  lastMeasuredInputTokens = tokens != null && tokens > 0 ? tokens : null
}

export function getLastMeasuredInputTokens(): number | null {
  return lastMeasuredInputTokens
}

function estimateUserContentTokens(content: UserContent): number {
  if (typeof content === 'string') return content.length / 4
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += block.text.length / 4
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- explicit guard so future non-image block types are not miscounted as images
    else if (block.type === 'image') total += ESTIMATED_IMAGE_TOKENS
  }
  return total
}

function estimateSingleMessageTokens(message: LLMMessage): number {
  switch (message.role) {
    case 'system':
      return message.content.length / 4
    case 'user':
      return estimateUserContentTokens(message.content)
    case 'assistant':
      if (typeof message.content === 'string') return message.content.length / 4
      return JSON.stringify(message.content).length / 4
    case 'tool':
      return JSON.stringify(message.toolResults).length / 4
    default:
      return 0
  }
}

/** Rough token estimate (~4 chars per token). Good enough for budget trimming. */
export function estimateMessageTokens(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateSingleMessageTokens(m)
  return total
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
  const conv = conversationMessages(messages)
  let total = JSON.stringify(conv).length / 4
  for (const m of conv) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'image') {
          total -= block.dataUrl.length / 4
          total += ESTIMATED_IMAGE_TOKENS
        }
      }
    }
  }
  return total
}

/** Prefer provider-reported input size when available (#52). */
export function effectiveConversationTokens(messages: LLMMessage[]): number {
  if (lastMeasuredInputTokens != null) return lastMeasuredInputTokens
  return estimateConversationTokens(messages)
}

/**
 * A single message's additive contribution to {@link estimateConversationTokens}.
 *
 * `estimateConversationTokens` stringifies the whole conversation array, whose
 * length is `sum(len(msg)) + (n + 1)` — two brackets plus `n - 1` commas. Folding
 * one separator unit into every element makes the estimate a simple sum:
 * `estimateConversationTokens(conv) === CONVERSATION_ENVELOPE_TOKENS + Σ estimate`.
 * Every term is a multiple of 0.25, so the sum is exact in IEEE-754 doubles, which
 * lets `trimMessagesInPlace` subtract a dropped message's estimate on each splice
 * instead of re-stringifying the entire conversation every iteration (#583).
 */
function conversationMessageEstimate(message: LLMMessage): number {
  let tokens = (JSON.stringify(message).length + 1) / 4
  if (message.role === 'user' && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'image') {
        tokens -= block.dataUrl.length / 4
        tokens += ESTIMATED_IMAGE_TOKENS
      }
    }
  }
  return tokens
}

/** Constant `[]`/separator overhead left over once each element folds in one unit. */
const CONVERSATION_ENVELOPE_TOKENS = 1 / 4

/** Ensure every assistant tool_use block has matching tool_result rows (#54). */
export function repairToolUseToolResultPairing(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue

    const toolIds = m.content.map((tc) => tc.id)
    if (toolIds.length === 0) continue

    const next = messages[i + 1]
    if (next?.role === 'tool') {
      const have = new Set(next.toolResults.map((r) => r.toolCallId))
      for (const id of toolIds) {
        if (!have.has(id)) {
          next.toolResults.push({ toolCallId: id, result: CANCELLED_TOOL_RESULT })
        }
      }
    } else {
      messages.splice(i + 1, 0, {
        role: 'tool',
        toolResults: toolIds.map((id) => ({
          toolCallId: id,
          result: CANCELLED_TOOL_RESULT,
        })),
      })
      i++
    }
  }
}

/** How many messages to remove at `index` (assistant+tool pairs drop together). */
function droppableSpan(messages: LLMMessage[], index: number): number {
  const m = messages[index]
  if (!m || m.role === 'user') return 0
  if (m.role === 'tool') {
    const prev = messages[index - 1]
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) return 0
    return 1
  }
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

  repairToolUseToolResultPairing(messages)

  // Precompute per-message estimates once and track the running total, so each
  // trim step subtracts the dropped message(s) instead of re-stringifying the
  // whole conversation every iteration (#583). When a provider-measured input
  // size is available it is used verbatim and stays fixed across drops, exactly
  // as effectiveConversationTokens would return it. `estimates` stays index-aligned
  // with `messages`; the system prompt is never a drop target.
  const measured = getLastMeasuredInputTokens()
  let estimates: number[] | null = null
  let currentTokens: number
  if (measured != null) {
    currentTokens = measured
  } else {
    estimates = messages.map(conversationMessageEstimate)
    const start = contentStartIndex(messages)
    let total = CONVERSATION_ENVELOPE_TOKENS
    for (let i = start; i < estimates.length; i++) total += estimates[i] ?? 0
    currentTokens = total
  }

  while (messages.length > minTail && currentTokens > conversationBudget) {
    const dropIndex = findOldestDroppableIndex(messages, minTail)
    if (dropIndex < 0) break
    const span = droppableSpan(messages, dropIndex)
    if (estimates != null) {
      for (let i = dropIndex; i < dropIndex + span; i++) currentTokens -= estimates[i] ?? 0
      estimates.splice(dropIndex, span)
    }
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
