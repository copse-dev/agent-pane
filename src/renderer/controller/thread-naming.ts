import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getThreadById, setThreadTitle } from '@shared/store/thread-helpers.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'

// Threads we've already attempted to auto-name, to avoid repeat calls.
const namedThreads = new Set<string>()

function firstWords(text: string, n = 6): string {
  return text.split(/\s+/).slice(0, n).join(' ').slice(0, 60) || 'New Thread'
}

/**
 * First-pass thread naming: kick off when the agent first responds (visible text
 * or a tool call), so the title overlaps the rest of the turn instead of waiting
 * for `done`. Uses the configured small-tasks model, with a plain word-slice
 * fallback. No-ops once a thread has been attempted or renamed.
 */
export function maybeNameThread(store: AppStore, api: ApiClient, threadId: string): void {
  if (namedThreads.has(threadId)) return
  const thread = getThreadById(store, threadId)
  if (!thread || thread.title !== 'New Thread') return
  const firstUser = thread.messages.find((m) => m.role === 'user')
  if (!firstUser || !firstUser.content.trim()) return
  namedThreads.add(threadId)

  void (async (): Promise<void> => {
    let title: string | null
    try {
      title = await api.agent.suggestTitle(firstUser.content)
    } catch {
      title = null
    }
    // Skip if the user renamed the thread while the suggestion was in flight.
    const current = getThreadById(store, threadId)
    if (!current || current.title !== 'New Thread') return
    setThreadTitle(store, threadId, nonEmptyStringOr(title?.trim(), firstWords(firstUser.content)))
  })()
}
