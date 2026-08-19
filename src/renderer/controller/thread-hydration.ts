import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { begin as perfBegin } from '../perf.ts'

/**
 * PROTOTYPE (lazy thread loading): fetch the active thread's transcript on
 * demand.
 *
 * With `COPSE_LAZY_THREADS=1` the main process returns a project's threads as
 * metadata only — `messages: []` and `messagesLoaded: false`. The sidebar draws
 * fine from that (a row is a title, a status dot and a PR chip), but the
 * conversation pane needs the real transcript, so exactly one thread's worth is
 * read when it becomes the active one.
 *
 * `messagesLoaded === false` is the only trigger. Threads loaded the old way
 * leave the field `undefined`, so with the flag off nothing here ever fires and
 * the behaviour is bit-for-bit unchanged — which is what makes the A/B honest.
 */
export function attachThreadHydration(store: AppStore, api: ApiClient): () => void {
  /** Threads already being fetched, so re-entrant events don't double-fetch. */
  const inFlight = new Set<string>()

  const hydrate = (): void => {
    const { activeProjectId, activeThreadId, threads } = store.getState()
    if (!activeProjectId || !activeThreadId) return
    const thread = threads.find((t) => t.id === activeThreadId)
    if (!thread || thread.messagesLoaded !== false || inFlight.has(thread.id)) return

    const projectId = activeProjectId
    const threadId = thread.id
    inFlight.add(threadId)
    const endHydrate = perfBegin('thread:hydrate')
    void api.threads
      .loadMessages(projectId, threadId)
      .then((messages) => {
        endHydrate({ messages: messages.length })
        // Re-read state rather than closing over it: the fetch is async and the
        // user may have switched project or thread meanwhile. Applying to a
        // project that is no longer active would put another project's
        // transcript into the visible list.
        const state = store.getState()
        if (state.activeProjectId !== projectId) return
        if (!state.threads.some((t) => t.id === threadId)) return
        store.setState({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, messages, messagesLoaded: true } : t,
          ),
        })
        store.emit('threads_changed')
      })
      .catch((err: unknown) => {
        // Leave `messagesLoaded` false so selecting the thread again retries.
        console.error('[threads] failed to load transcript', err)
      })
      .finally(() => {
        inFlight.delete(threadId)
      })
  }

  // Re-entrancy is bounded: the only path that emits `threads_changed` from here
  // sets `messagesLoaded: true` first, so the re-entrant call returns at the
  // guard above rather than fetching again.
  const offThreads = store.on('threads_changed', hydrate)
  const offWorkspace = store.on('workspace_changed', hydrate)
  hydrate()
  return () => {
    offThreads()
    offWorkspace()
  }
}
