import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'
import { compactionReplayStart, type CompactionIdentity } from '@copse/llm/provider-state.ts'
import { CHARS_PER_TOKEN, ESTIMATED_IMAGE_TOKENS } from './token-estimate.ts'

// Re-exported so existing consumers keep importing from a single module.
export { ESTIMATED_IMAGE_TOKENS } from './token-estimate.ts'

export const CANCELLED_TOOL_RESULT = 'Tool execution cancelled.'

let lastMeasuredInputTokens: number | null = null

export function setLastMeasuredInputTokens(tokens: number | null): void {
  lastMeasuredInputTokens = tokens != null && tokens > 0 ? tokens : null
}

export function getLastMeasuredInputTokens(): number | null {
  return lastMeasuredInputTokens
}

function estimateUserContentTokens(content: UserContent): number {
  if (typeof content === 'string') return content.length / CHARS_PER_TOKEN
  let total = 0
  for (const block of content) {
    // A switch rather than if/else so a future block type is not miscounted as
    // an image; switch-exhaustiveness-check flags the new case instead.
    switch (block.type) {
      case 'text':
        total += block.text.length / CHARS_PER_TOKEN
        break
      case 'image':
        total += ESTIMATED_IMAGE_TOKENS
        break
    }
  }
  return total
}

/**
 * Correction for images carried on a tool result. Every estimator here starts
 * from `JSON.stringify(...).length / 4`, which prices a base64 data URL at its
 * literal size — off by orders of magnitude for a screenshot. Swap each one for
 * the same flat per-image estimate user-attached images already use.
 */
function toolResultImageAdjustment(toolResults: LLMMessage & { role: 'tool' }): number {
  let adjustment = 0
  for (const result of toolResults.toolResults) {
    for (const image of result.images ?? []) {
      adjustment -= image.dataUrl.length / CHARS_PER_TOKEN
      adjustment += ESTIMATED_IMAGE_TOKENS
    }
  }
  return adjustment
}

function estimateSingleMessageTokens(message: LLMMessage): number {
  switch (message.role) {
    case 'system':
    case 'developer':
      return message.content.length / CHARS_PER_TOKEN
    case 'user':
      return estimateUserContentTokens(message.content)
    case 'assistant':
      if (typeof message.content === 'string') return message.content.length / CHARS_PER_TOKEN
      return JSON.stringify(message.content).length / CHARS_PER_TOKEN
    case 'tool':
      return (
        JSON.stringify(message.toolResults).length / CHARS_PER_TOKEN +
        toolResultImageAdjustment(message)
      )
    // An opaque encrypted blob, not prompt text. What it costs in the window is
    // what the provider reports back (see `effectiveConversationTokens`).
    case 'provider_state':
      return 0
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

/**
 * The messages a provider that replays `compaction` will actually send: the
 * compaction item stands in for every turn before it, so those are left out, and
 * the opaque item itself is not prompt text. Instructions stay. With no
 * applicable compaction this is `messages` minus any provider state, so callers
 * can size the request without knowing whether a compaction is in play.
 */
export function replayWindow(
  messages: readonly LLMMessage[],
  compaction: CompactionIdentity | undefined,
): LLMMessage[] {
  const anchor = compactionReplayStart(messages, compaction)
  const out: LLMMessage[] = []
  for (const [i, message] of messages.entries()) {
    if (message.role === 'provider_state') continue
    if (i < anchor && message.role !== 'system' && message.role !== 'developer') continue
    out.push(message)
  }
  return out
}

/**
 * Prompt size at which server-side compaction should fire: comfortably below the
 * point where {@link trimMessagesInPlace} starts dropping turns, so the provider
 * summarises (keeping its encrypted reasoning) before Copse discards anything.
 * Client-side trimming stays the fallback for any transport that cannot compact.
 */
export const SERVER_COMPACTION_FILL = 0.75

export function serverCompactionThreshold(
  maxContextTokens: number,
  opts?: { reserveTokens?: number },
): number {
  return Math.max(
    1,
    Math.floor(historyTokenBudget(maxContextTokens, opts) * SERVER_COMPACTION_FILL),
  )
}

export function estimateConversationTokens(messages: LLMMessage[]): number {
  const conv = conversationMessages(messages).filter((message) => message.role !== 'provider_state')
  let total = JSON.stringify(conv).length / CHARS_PER_TOKEN
  for (const m of conv) {
    if (m.role === 'tool') total += toolResultImageAdjustment(m)
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'image') {
          total -= block.dataUrl.length / CHARS_PER_TOKEN
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
  if (message.role === 'provider_state') return 0
  let tokens = (JSON.stringify(message).length + 1) / CHARS_PER_TOKEN
  if (message.role === 'tool') tokens += toolResultImageAdjustment(message)
  if (message.role === 'user' && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'image') {
        tokens -= block.dataUrl.length / CHARS_PER_TOKEN
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
  if (!m || m.role === 'user' || m.role === 'provider_state') return 0
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

function findOldestDroppableIndex(
  messages: LLMMessage[],
  minTail: number,
  firstCandidate: number,
): number {
  const start = Math.max(contentStartIndex(messages), firstCandidate)
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
    /**
     * The compaction the provider will replay. Turns before it are already
     * summarised server-side: they are not counted and not dropped, so trimming
     * only spends the turns that follow it.
     */
    compaction?: CompactionIdentity | undefined
  },
): boolean {
  const minTail = opts?.minTailMessages ?? 5
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, opts)
  let trimmed = false

  repairToolUseToolResultPairing(messages)

  // Precompute per-message estimates once and track a running total, so each trim
  // step subtracts the dropped message(s) instead of re-stringifying the whole
  // conversation every iteration (#583). The running total must shrink as we drop
  // even when a provider-measured input size is available (#52): the measured value
  // is a fixed snapshot of the previous request and never shrinks on its own, so
  // seeding `currentTokens` from it and then not decrementing would collapse the
  // whole history down to `minTail` on the first pass once measured tokens cross the
  // budget. Seed from the measured size when present (more accurate than the
  // estimate), otherwise from the estimated total, then decrement by our per-message
  // estimates on every drop. `estimates` stays index-aligned with `messages`; the
  // system prompt is never a drop target.
  const measured = getLastMeasuredInputTokens()
  const anchor = compactionReplayStart(messages, opts?.compaction)
  const estimates = messages.map((message, i) =>
    i < anchor && message.role !== 'system' && message.role !== 'developer'
      ? 0
      : conversationMessageEstimate(message),
  )
  let currentTokens: number
  if (measured != null) {
    currentTokens = measured
  } else {
    const start = contentStartIndex(messages)
    let total = CONVERSATION_ENVELOPE_TOKENS
    for (let i = start; i < estimates.length; i++) total += estimates[i] ?? 0
    currentTokens = total
  }

  while (messages.length > minTail && currentTokens > conversationBudget) {
    const dropIndex = findOldestDroppableIndex(messages, minTail, anchor + 1)
    if (dropIndex < 0) break
    const span = droppableSpan(messages, dropIndex)
    for (let i = dropIndex; i < dropIndex + span; i++) currentTokens -= estimates[i] ?? 0
    estimates.splice(dropIndex, span)
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
    compaction?: CompactionIdentity | undefined
  },
): { messages: LLMMessage[]; trimmed: boolean } {
  const copy = [...messages]
  const trimmed = trimMessagesInPlace(copy, maxContextTokens, opts)
  return { messages: copy, trimmed }
}
