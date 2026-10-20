import type { Thread } from './thread-types.ts'

/**
 * Build an empty thread that records `parent` as its origin. Nothing is copied:
 * the follow-up reads the parent on demand. Follow-ups link to the thread they
 * were started from only, so a follow-up of a follow-up reads its own parent
 * and never the grandparent.
 */
export function buildFollowUpThread(parent: Thread, model?: string): Thread {
  const now = Date.now()
  return {
    id: globalThis.crypto.randomUUID(),
    title: `Follow-up: ${parent.title}`,
    status: 'idle',
    messages: [],
    prRefs: [],
    links: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(model !== undefined
      ? { model }
      : parent.model !== undefined
        ? { model: parent.model }
        : {}),
    followUpOf: { parentThreadId: parent.id },
    createdAt: now,
    updatedAt: now,
  }
}
