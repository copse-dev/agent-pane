import type { Message } from '@shared/types'

/** Enough to read the reply in the pane; the full text is one click away in the thread. */
export const FINAL_REPLY_MAX_CHARS = 20_000
/** Replies kept for rows the user has looked at; older ones reload when shown again. */
export const FINAL_REPLY_CACHE_SIZE = 20

export type FinalReply = { state: 'loading' } | { state: 'ready'; text: string | null }

/**
 * What the agent last said in the thread's latest turn, or null when that turn
 * ended without prose. Stops at the latest user message so an earlier turn's
 * reply is never passed off as this one's.
 */
export function finalReplyText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role === 'user') return null
    if (message.role !== 'assistant') continue
    const text = message.content.trim()
    if (text === '') continue
    return text.length <= FINAL_REPLY_MAX_CHARS
      ? text
      : `${text.slice(0, FINAL_REPLY_MAX_CHARS).trimEnd()}…`
  }
  return null
}

export interface FinalReplyRequest {
  /** Identity of the run the reply belongs to: a newer run of the thread must not reuse it. */
  key: string
  projectId: string
  threadId: string
  /** The transcript when the renderer already holds it; null to read it from the thread store. */
  messages: readonly Message[] | null
}

/**
 * Final replies for settled Activity rows, read on demand. The Activity model
 * never reads transcripts; this does, but only for the row in the detail pane.
 */
export function createFinalReplyCache(
  load: (projectId: string, threadId: string) => Promise<readonly Message[]>,
  onLoaded: () => void,
): (request: FinalReplyRequest) => FinalReply {
  const entries = new Map<string, FinalReply>()
  const remember = (key: string, reply: FinalReply): void => {
    entries.delete(key)
    entries.set(key, reply)
    while (entries.size > FINAL_REPLY_CACHE_SIZE) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }
  return (request) => {
    if (request.messages) {
      const reply: FinalReply = { state: 'ready', text: finalReplyText(request.messages) }
      remember(request.key, reply)
      return reply
    }
    const known = entries.get(request.key)
    if (known) return known
    const loading: FinalReply = { state: 'loading' }
    remember(request.key, loading)
    load(request.projectId, request.threadId).then(
      (messages) => {
        remember(request.key, { state: 'ready', text: finalReplyText(messages) })
        onLoaded()
      },
      () => {
        remember(request.key, { state: 'ready', text: null })
        onLoaded()
      },
    )
    return loading
  }
}
