import type { Thread } from '@shared/types'

/**
 * A minimal idle thread for renderer store tests. Pass the fields a test reads;
 * the rest default to an empty, loaded, idle thread.
 *
 * Test-only: nothing in the app's build graph imports this.
 */
export function makeThread(fields: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  return {
    title: fields.id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}
