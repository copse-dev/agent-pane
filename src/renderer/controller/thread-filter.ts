import { isHumanUserPrompt, sortThreadsNewestFirst } from '@copse/thread-store/thread-sort.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { Message } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'

interface ThreadFilter {
  search(query: string): void
  cancel(): void
  readonly matches: ReadonlySet<string>
  readonly pending: boolean
  readonly failed: boolean
}

/** Search one transcript at a time without hydrating or retaining it in the store. */
export function createThreadFilter(
  store: AppStore,
  api: ApiClient,
  changed: () => void,
): ThreadFilter {
  const matches = new Set<string>()
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let scan = Promise.resolve()
  let pending = false
  let failed = false

  const cancel = (): void => {
    generation += 1
    clearTimeout(timer)
    matches.clear()
    pending = false
    failed = false
  }

  const search = (query: string): void => {
    cancel()
    const { activeProjectId, threads } = store.getState()
    if (!query || !activeProjectId) return
    const current = generation
    const isCurrent = (): boolean =>
      current === generation && store.getState().activeProjectId === activeProjectId
    const candidates = sortThreadsNewestFirst(threads).filter(
      (thread) =>
        thread.archivedAt == null && !(thread.title || 'New Thread').toLowerCase().includes(query),
    )
    const containsRequest = (messages: Message[]): boolean =>
      messages.some(
        (message) => isHumanUserPrompt(message) && message.content.toLowerCase().includes(query),
      )
    pending = candidates.length > 0
    // Keep the initial title filter immediate and avoid disk reads during typing.
    timer = setTimeout(() => {
      // A superseded scan can finish its current read, but never starts another.
      // Chaining prevents rapid query changes from piling up transcript reads.
      scan = scan.then(async () => {
        for (const thread of candidates) {
          if (!isCurrent()) return
          try {
            // Live messages may have arrived before a lazy transcript is loaded.
            const matched =
              containsRequest(thread.messages) ||
              (thread.messagesLoaded === false &&
                containsRequest(await api.threads.loadMessages(activeProjectId, thread.id)))
            if (!isCurrent()) return
            if (matched) {
              matches.add(thread.id)
              changed()
            }
          } catch {
            if (!isCurrent()) return
            failed = true
          }
        }
        if (!isCurrent()) return
        pending = false
        changed()
      })
    }, 200)
  }

  return {
    search,
    cancel,
    matches,
    get pending(): boolean {
      return pending
    },
    get failed(): boolean {
      return failed
    },
  }
}
