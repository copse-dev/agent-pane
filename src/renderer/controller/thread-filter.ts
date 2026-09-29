import { isHumanUserPrompt, sortThreadsNewestFirst } from '@copse/thread-store/thread-sort.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'

/**
 * Shorter queries filter titles only. A single character matches nearly every
 * transcript, so reading them all would cost a full scan for no narrowing.
 */
export const MIN_REQUEST_QUERY_LENGTH = 2

/** Debounce before a query starts reading saved transcripts. */
const SCAN_DELAY_MS = 200

/**
 * Upper bound on the cached, lowercased request text (UTF-16 units). Pasted
 * logs can make single prompts large; past this the oldest entries are dropped
 * and re-read on demand.
 */
const PROMPT_INDEX_MAX_CHARS = 8_000_000

/** Case-folded, NFC-normalised text, so composed and decomposed accents match. */
export function filterText(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

const filterableContentCache = new WeakMap<Message, { content: string; text: string }>()

/**
 * {@link filterText} of a message's content, cached on the message object.
 * The sidebar re-renders on every streaming chunk while a filter is open; this
 * keeps it from re-normalising every resident request each time.
 */
function filterableContent(message: Message): string {
  const cached = filterableContentCache.get(message)
  if (cached?.content === message.content) return cached.text
  const text = filterText(message.content)
  filterableContentCache.set(message, { content: message.content, text })
  return text
}

/** True when a resident human request contains `query` (already {@link filterText}-ed). */
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
  /** A transcript scan is running. */
  readonly pending: boolean
  /** The query is waiting out the debounce; no scan has started yet. */
  readonly waiting: boolean
  readonly failed: boolean
}

interface PromptIndexEntry {
  /**
   * The thread's `updatedAt` and `lastPromptAt` when it was indexed. Every
   * saved change to a thread (a new request, an edit, a truncation) moves
   * `updatedAt`, which is what invalidates the entry.
   */
  updatedAt: number
  lastPromptAt: number | undefined
  prompts: string[]
  size: number
}

/**
 * Search saved human requests one transcript at a time, without hydrating or
 * retaining transcripts in the store. Each thread's requests are indexed once
 * (lowercased, NFC) and reused across queries until the thread is saved again.
 */
export function createThreadFilter(
  store: AppStore,
  api: ApiClient,
  changed: () => void,
): ThreadFilter {
  const matches = new Set<string>()
  const promptIndex = new Map<string, PromptIndexEntry>()
  let promptIndexSize = 0
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let scan = Promise.resolve()
  let pending = false
  let waiting = false
  let failed = false

  const forget = (key: string): void => {
    const entry = promptIndex.get(key)
    if (!entry) return
    promptIndex.delete(key)
    promptIndexSize -= entry.size
  }

  const remember = (key: string, entry: PromptIndexEntry): void => {
    forget(key)
    promptIndex.set(key, entry)
    promptIndexSize += entry.size
    for (const oldest of promptIndex.keys()) {
      if (promptIndexSize <= PROMPT_INDEX_MAX_CHARS || oldest === key) break
      forget(oldest)
    }
  }

  const savedPrompts = async (projectId: string, thread: Thread): Promise<string[]> => {
    const key = `${projectId}/${thread.id}`
    const cached = promptIndex.get(key)
    if (
      cached &&
      cached.updatedAt === thread.updatedAt &&
      cached.lastPromptAt === thread.lastPromptAt
    ) {
      return cached.prompts
    }
    const messages = await api.threads.loadMessages(projectId, thread.id)
    const prompts = messages.filter(isHumanUserPrompt).map((message) => filterText(message.content))
    const size = prompts.reduce((total, prompt) => total + prompt.length, 0)
    // Kept even when this scan has been superseded: the read already happened.
    remember(key, {
      updatedAt: thread.updatedAt,
      lastPromptAt: thread.lastPromptAt,
      prompts,
      size,
    })
    return prompts
  }

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
  }

  const search = (rawQuery: string): void => {
    cancel()
    const query = filterText(rawQuery)
    const { activeProjectId, threads } = store.getState()
    if (query.length < MIN_REQUEST_QUERY_LENGTH || !activeProjectId) return
    const current = generation
    const isCurrent = (): boolean =>
      current === generation && store.getState().activeProjectId === activeProjectId
    const candidates = sortThreadsNewestFirst(threads).filter(
      (thread) =>
        thread.archivedAt == null && !filterText(thread.title || 'New Thread').includes(query),
    )
    if (candidates.length === 0) return
    waiting = true
    // Keep the initial title filter immediate and avoid disk reads during typing.
    timer = setTimeout(() => {
      waiting = false
      pending = true
      notify()
      // A superseded scan can finish its current read, but never starts another.
      // Chaining prevents rapid query changes from piling up transcript reads.
      scan = scan
        .then(async () => {
          for (const thread of candidates) {
            if (!isCurrent()) return
            try {
              // Live messages may have arrived before a lazy transcript is loaded.
              const matched =
                residentRequestMatches(thread.messages, query) ||
                (thread.messagesLoaded === false &&
                  (await savedPrompts(activeProjectId, thread)).some((prompt) =>
                    prompt.includes(query),
                  ))
              if (!isCurrent()) return
              if (matched) {
                matches.add(thread.id)
                notify()
              }
            } catch {
              if (!isCurrent()) return
              failed = true
            }
          }
          if (!isCurrent()) return
          pending = false
          notify()
        })
        .catch((error: unknown) => {
          // Never leave the chain rejected: every later scan would be skipped and
          // "Searching…" would stay up for the rest of the session.
          console.error('[thread-filter] request scan failed', error)
          if (!isCurrent()) return
          pending = false
          failed = true
          notify()
        })
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
