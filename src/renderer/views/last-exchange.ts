import type { AppStore } from '@shared/store/store.ts'
import { normalizeFollowUpOpenTodos, type FollowUpContext } from '@shared/follow-ups/types.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'

export interface LastExchange {
  /**
   * Identity of the finished turn (thread + user msg + assistant msg). One-shot
   * post-turn model calls key their caches on this so a turn is only ever
   * billed once, however many times the thread is revisited.
   */
  turnKey: string
  context: FollowUpContext
}

/**
 * The thread's completed final exchange, or null before the first full
 * user/assistant pair exists. Shared by the post-turn suggestion features
 * (follow-up bubbles, next-step tab complete) so they agree on what "the turn
 * that just finished" means.
 */
export function lastExchange(store: AppStore, threadId: string): LastExchange | null {
  const thread = getThreadById(store, threadId)
  if (!thread) return null

  const userMessages = thread.messages.filter((m) => m.role === 'user')
  const assistantMessages = thread.messages.filter((m) => m.role === 'assistant')
  const lastUser = userMessages.at(-1)
  const lastAssistant = assistantMessages.at(-1)
  if (!lastUser?.content.trim() || !lastAssistant) return null

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
  const toolNames = (lastAssistant.toolCalls ?? []).map((tc) => tc.name)
  // Plan items still open at turn end feed the deterministic "continue the
  // plan" bubble; an empty list (plan done, or thread runs no plan) means no
  // bubble.
  const openTodos = normalizeFollowUpOpenTodos(
    (thread.todos ?? [])
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.content),
  )
  return {
    turnKey: `${threadId}:${lastUser.id}:${lastAssistant.id}`,
    context: {
      userMessage: lastUser.content,
      assistantMessage: lastAssistant.content,
      toolNames,
      ...(openTodos.length > 0 ? { openTodos } : {}),
    },
  }
}
