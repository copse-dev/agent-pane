import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Thread } from '@shared/types'
import { collectThreadPrRefs } from '@shared/git/thread-pr-status.ts'
import { begin as perfBegin } from '../perf.ts'

/**
 * On-demand transcripts.
 *
 * A project's threads arrive from `threads:loadProject` as metadata only —
 * `messages: []` and `messagesLoaded: false` — because the sidebar draws a row
 * from a title, a status dot and a PR chip, and reading every transcript to
 * render one was the whole cost of opening a large project. The transcript for a
 * thread is read when that thread is actually opened.
 *
 * Two entry points, because two different things need a transcript:
 *
 *   - {@link attachThreadHydration} watches the active thread, for the user
 *     clicking around the sidebar.
 *   - {@link ensureThreadMessages} is awaited by code that is about to write
 *     into a thread the user may never have opened — an automation trigger, a
 *     queued message resuming after restart. Appending onto a transcript that
 *     was never loaded would render as a conversation that began mid-sentence.
 *
 * Note the agent's own LLM context is NOT affected either way: `agent:run`
 * passes ids and a prompt, and the main process reads history from
 * `agent-history.json` on disk. Hydration is about what the renderer displays.
 */

/**
 * How many transcripts to keep in memory per project.
 *
 * Lazy loading fixes the cost of *opening* a project, but a long session spent
 * clicking through threads would otherwise re-accumulate exactly the heap the
 * eager load used to allocate up front. Eight is comfortably more than anyone
 * revisits in a sitting and small enough that the worst case is bounded.
 */
const HYDRATED_THREAD_BUDGET = 8

interface Hydrator {
  ensure(projectId: string, threadId: string): Promise<void>
}

/** Set by {@link attachThreadHydration}; the imperative API routes through it. */
let activeHydrator: Hydrator | null = null

/**
 * Load `threadId`'s transcript if it is not already in memory, and resolve once
 * the store holds it. Safe to call for a thread that is already hydrated (it
 * returns immediately) and safe to call concurrently for the same thread.
 */
export function ensureThreadMessages(projectId: string, threadId: string): Promise<void> {
  return activeHydrator?.ensure(projectId, threadId) ?? Promise.resolve()
}

/** True when this thread's transcript is known to be absent from memory. */
export function needsHydration(thread: Pick<Thread, 'messagesLoaded'>): boolean {
  return thread.messagesLoaded === false
}

/**
 * Threads whose transcript must stay resident regardless of recency: the one on
 * screen, anything the agent is streaming into, and anything with queued work
 * that will stream into it shortly.
 */
function isPinned(thread: Thread, activeThreadId: string | null): boolean {
  if (thread.id === activeThreadId) return true
  if (thread.status === 'running') return true
  return (thread.pendingMessages?.length ?? 0) > 0
}

export function attachThreadHydration(store: AppStore, api: ApiClient): () => void {
  /** In-flight fetches, so re-entrant events and callers share one request. */
  const inFlight = new Map<string, Promise<void>>()
  /** Hydrated thread ids, least-recently-used first. */
  let recency: string[] = []

  const touch = (threadId: string): void => {
    recency = [...recency.filter((id) => id !== threadId), threadId]
  }

  /**
   * Release transcripts beyond the budget, oldest first. Evicted threads go back
   * to `messagesLoaded: false`, which is exactly the state they loaded in — so
   * reselecting one re-hydrates through the ordinary path.
   */
  const evict = (): void => {
    const { threads, activeThreadId } = store.getState()
    const byId = new Map(threads.map((t) => [t.id, t]))
    const evictable = recency.filter((id) => {
      const thread = byId.get(id)
      return thread !== undefined && !isPinned(thread, activeThreadId)
    })
    const overBudget = evictable.length - HYDRATED_THREAD_BUDGET
    if (overBudget <= 0) return
    const dropping = new Set(evictable.slice(0, overBudget))
    recency = recency.filter((id) => !dropping.has(id))
    store.setState({
      threads: threads.map((t) =>
        dropping.has(t.id) ? { ...t, messages: [], messagesLoaded: false } : t,
      ),
    })
  }

  const fetchInto = (projectId: string, threadId: string): Promise<void> => {
    const key = `${projectId}:${threadId}`
    const existing = inFlight.get(key)
    if (existing) return existing

    const endHydrate = perfBegin('thread:hydrate')
    const request = api.threads
      .loadMessages(projectId, threadId)
      .then((messages) => {
        endHydrate({ messages: messages.length })
        // Re-read state rather than closing over it: the fetch is async and the
        // user may have switched project or thread meanwhile. Applying to a
        // project that is no longer active would put one project's transcript
        // into another's thread list.
        const state = store.getState()
        if (state.activeProjectId !== projectId) return
        if (!state.threads.some((t) => t.id === threadId)) return
        store.setState({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, messages, messagesLoaded: true } : t,
          ),
        })
        touch(threadId)
        evict()
        store.emit('threads_changed')
      })
      .catch((err: unknown) => {
        // Leaving `messagesLoaded` false means selecting the thread again
        // retries, rather than showing an empty transcript forever.
        console.error('[threads] could not load transcript', err)
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, request)
    return request
  }

  activeHydrator = {
    ensure: (projectId: string, threadId: string): Promise<void> => {
      const state = store.getState()
      const thread = state.threads.find((t) => t.id === threadId)
      // Unknown thread, or one already holding its transcript: nothing to do.
      if (thread && !needsHydration(thread)) {
        touch(threadId)
        return Promise.resolve()
      }
      return fetchInto(projectId, threadId)
    },
  }

  const hydrateActive = (): void => {
    const { activeProjectId, activeThreadId, threads } = store.getState()
    if (!activeProjectId || !activeThreadId) return
    const thread = threads.find((t) => t.id === activeThreadId)
    if (!thread) return
    if (!needsHydration(thread)) {
      touch(activeThreadId)
      return
    }
    void fetchInto(activeProjectId, activeThreadId)
  }

  // Re-entrancy is bounded: the emit above only happens after `messagesLoaded`
  // is set true, so the re-entrant call returns at the guard rather than
  // fetching again.
  const offThreads = store.on('threads_changed', hydrateActive)
  const offWorkspace = store.on('workspace_changed', hydrateActive)
  hydrateActive()

  // Batches from the main process's one-time PR-ref backfill. Applied only to
  // the project they belong to, and never over a thread whose transcript is in
  // memory — there, the live scrape is authoritative (see `sidebarPrRefs`).
  const offPrRefs = api.threads.onPrRefs((projectId, refs): void => {
    const state = store.getState()
    if (state.activeProjectId !== projectId || refs.length === 0) return
    const byThread = new Map(refs.map((entry) => [entry.threadId, entry.prRefs]))
    if (!state.threads.some((t) => byThread.has(t.id))) return
    store.setState({
      threads: state.threads.map((t) => {
        const prRefs = byThread.get(t.id)
        return prRefs && needsHydration(t) ? { ...t, prRefs } : t
      }),
    })
    store.emit('threads_changed')
  })

  return () => {
    offThreads()
    offWorkspace()
    offPrRefs()
    activeHydrator = null
    recency = []
    inFlight.clear()
  }
}

/**
 * PR refs for a freshly hydrated thread, for persisting back into its metadata.
 *
 * The sidebar chip is derived from PR links in message text, which is precisely
 * what a metadata-only load does not have. Recording the scrape's result on the
 * thread's metadata means the chip survives the next launch without the
 * transcript being read again. Returns null when there is nothing new to store,
 * so the caller can skip a pointless write.
 */
export function prRefsToPersist(thread: Thread): ReturnType<typeof collectThreadPrRefs> | null {
  if (!thread.messagesLoaded) return null
  const refs = collectThreadPrRefs(thread)
  const current = thread.prRefs ?? []
  if (refs.length === current.length && refs.every((r, i) => current[i]?.url === r.url)) return null
  return refs
}
