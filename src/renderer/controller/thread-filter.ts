import { isHumanUserPrompt } from '@copse/thread-store/thread-sort.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { Message } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'

/** Shorter queries filter titles only. */
export const MIN_REQUEST_QUERY_LENGTH = 2
const SCAN_DELAY_MS = 200

/** Case-folded, NFC-normalised text, so composed and decomposed accents match. */
export function filterText(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

const filterableContentCache = new WeakMap<Message, { content: string; text: string }>()

function filterableContent(message: Message): string {
  const cached = filterableContentCache.get(message)
  if (cached?.content === message.content) return cached.text
  const text = filterText(message.content)
  filterableContentCache.set(message, { content: message.content, text })
  return text
}

/** Include unsaved, resident human requests as soon as they arrive. */
export function residentRequestMatches(messages: readonly Message[], query: string): boolean {
  if (query.length < MIN_REQUEST_QUERY_LENGTH) return false
  return messages.some(
    (message) => isHumanUserPrompt(message) && filterableContent(message).includes(query),
  )
}

interface ThreadFilter {
  search(query: string): void
  cancel(): void
  readonly matches: ReadonlySet<string>
  readonly pending: boolean
  readonly waiting: boolean
  readonly failed: boolean
}

/** Saved text stays in the worker's persistent index; only IDs cross IPC. */
export function createThreadFilter(
  store: AppStore,
  api: ApiClient,
  changed: () => void,
): ThreadFilter {
  const matches = new Set<string>()
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let waiting = false
  let failed = false

  const notify = (): void => {
    try {
      changed()
    } catch (error) {
      console.error('[thread-filter] sidebar update failed', error)
    }
  }

  const cancel = (): void => {
    generation += 1
    clearTimeout(timer)
    matches.clear()
    pending = false
    waiting = false
    failed = false
    void api.threads.cancelRequestSearch().catch(() => {})
  }

  const search = (rawQuery: string): void => {
    cancel()
    const query = filterText(rawQuery)
    const { activeProjectId, threads } = store.getState()
    if (query.length < MIN_REQUEST_QUERY_LENGTH || !activeProjectId) return
    const current = generation
    const isCurrent = (): boolean =>
      current === generation && store.getState().activeProjectId === activeProjectId
    const candidates = threads.filter(
      (thread) =>
        thread.archivedAt == null && !filterText(thread.title || 'New Thread').includes(query),
    )
    if (candidates.length === 0) return
    waiting = true
    timer = setTimeout(() => {
      waiting = false
      pending = true
      notify()
      const run = async (): Promise<void> => {
        try {
          // Loaded histories are authoritative over an older saved projection.
          for (const thread of candidates) {
            if (residentRequestMatches(thread.messages, query)) matches.add(thread.id)
          }
          if (candidates.some((thread) => thread.messagesLoaded === false)) {
            const result = await api.threads.searchRequests(activeProjectId, query)
            if (!isCurrent()) return
            const lazy = new Set(
              candidates
                .filter((thread) => thread.messagesLoaded === false)
                .map((thread) => thread.id),
            )
            for (const id of result.matches) if (lazy.has(id)) matches.add(id)
            failed = result.incomplete
          }
        } catch {
          if (!isCurrent()) return
          failed = true
        }
        if (!isCurrent()) return
        pending = false
        notify()
      }
      void run()
    }, SCAN_DELAY_MS)
  }

  return {
    search,
    cancel,
    matches,
    get pending(): boolean {
      return pending
    },
    get waiting(): boolean {
      return waiting
    },
    get failed(): boolean {
      return failed
    },
  }
}
