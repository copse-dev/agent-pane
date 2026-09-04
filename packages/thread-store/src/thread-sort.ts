import type { Message, Thread } from './thread-types.ts'

/**
 * True for a prompt a human actually submitted.
 *
 * `origin` is absent on human-authored messages; a hook-queued or machine
 * continuation carries one (see `MessageOrigin`). `editedByUser` is the case
 * where a human took a hook's message over and rewrote it before it dispatched
 * — the origin stays `hook` so authorship is never lost, but the words are the
 * user's, so it counts as their prompt.
 */
export function isHumanUserPrompt(message: Message): boolean {
  return message.role === 'user' && (message.origin === undefined || message.editedByUser === true)
}

/**
 * When the user last prompted this thread, or undefined if they never have.
 *
 * Prefers the persisted {@link Thread.lastPromptAt}, which is the only source a
 * metadata-only sidebar load has. Threads written before that field existed fall
 * back to their transcript when one is loaded — which is also what lets the
 * hydration path record the value so the next load does not need the transcript.
 */
export function lastHumanPromptAt(thread: Thread): number | undefined {
  if (thread.lastPromptAt !== undefined) return thread.lastPromptAt
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]
    if (message !== undefined && isHumanUserPrompt(message)) return message.createdAt
  }
  return undefined
}

/**
 * The default thread ordering: most recently prompted first.
 *
 * A thread nobody has prompted yet (a blank "New Thread", or one whose only
 * turns were machine continuations) sorts on `createdAt`, which is also the
 * tie-break — so threads that have never been prompted keep exactly the order
 * they had before this key existed.
 */
export function threadSortKey(thread: Thread): number {
  return lastHumanPromptAt(thread) ?? thread.createdAt
}

export function sortThreadsNewestFirst(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) => threadSortKey(b) - threadSortKey(a) || b.createdAt - a.createdAt,
  )
}
