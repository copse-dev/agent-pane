import type { LLMMessage, UserContent } from '@shared/types'

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

  // The provider-measured input size (#52) is a fixed snapshot of the previous
  // request — it does NOT shrink as we splice messages out. Driving the loop
  // directly off it would drop every droppable message down to `minTail` on the
  // first pass once measured tokens cross the budget. Instead, track how much
  // estimated content we remove and subtract it from the measured baseline so the
  // loop stops as soon as the (approximate) remaining size fits. The estimate-only
  // path (no measured value) keeps recomputing exactly as before.
  const measured = lastMeasuredInputTokens
  let removedEstimate = 0
  const remainingTokens = (): number =>
    measured != null ? measured - removedEstimate : estimateConversationTokens(messages)

  while (messages.length > minTail && remainingTokens() > conversationBudget) {
    const dropIndex = findOldestDroppableIndex(messages, minTail)
    if (dropIndex < 0) break
    const span = droppableSpan(messages, dropIndex)
    removedEstimate += estimateMessageTokens(messages.slice(dropIndex, dropIndex + span))
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
