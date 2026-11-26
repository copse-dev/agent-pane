import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import type { Thread } from '@shared/types'
import { remoteViewSchema, type RemoteWatchedThread } from '@shared/remote-interface.ts'
import { locateMessage } from '@shared/store/thread-helpers.ts'

interface CapturedView {
  projectId: string
  threads: Thread[]
}

/** What a project was last published from, so an unchanged project is not sent again. */
interface PublishedFrom {
  threads: Thread[]
  watching: string
}

/**
 * Only an opted-in desktop owner publishes; remote clients never autosave these views.
 *
 * A view carries every thread's metadata, and a transcript only for the threads
 * a paired client is polling. Clients read any other thread's saved transcript
 * from disk, and a scoped poll never returns a sibling's transcript anyway.
 * Publishing every loaded transcript, and the whole project again on each
 * streamed token, passed 1 GB per call on a large profile and aborted the
 * renderer while it serialized the call (#4445).
 */
export function attachRemotePublisher(store: AppStore, api: ApiClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let disposed = false
  let receivedState = false
  let receivedWatched = false
  /** Watched thread ids by project. */
  let watched = new Map<string, Set<string>>()
  const views = new Map<string, CapturedView>()
  const published = new Map<string, PublishedFrom>()
  /**
   * Watched threads whose messages changed in place since the last publish.
   * The store streams tokens and tool calls into a message without copying the
   * thread or its array, so the identity check below cannot see them.
   */
  const streamedInto = new Set<string>()

  function capture(): void {
    const { activeProjectId, threads, backgroundThreads } = store.getState()
    if (activeProjectId) views.set(activeProjectId, { projectId: activeProjectId, threads })
    for (const { projectId, thread } of backgroundThreads) {
      const existing = views.get(projectId)?.threads ?? []
      // Already captured as this very object: keep the array, so the project
      // still reads as unchanged.
      if (existing.includes(thread)) continue
      views.set(projectId, {
        projectId,
        threads: [...existing.filter((item) => item.id !== thread.id), thread],
      })
    }
  }

  function forClients(projectId: string, thread: Thread): Thread {
    if (thread.messages.length === 0 || watched.get(projectId)?.has(thread.id)) return thread
    // The shape the desktop uses for a thread it has not opened.
    return { ...thread, messages: [], messagesLoaded: false }
  }

  function publish(): void {
    timer = null
    if (!running || disposed) return
    const streamed = new Set(streamedInto)
    streamedInto.clear()
    for (const { projectId, threads } of views.values()) {
      const watchedIds = [...(watched.get(projectId) ?? [])]
      const watching = watchedIds.sort().join('\0')
      const last = published.get(projectId)
      const unchanged = last?.threads === threads && last.watching === watching
      if (unchanged && !watchedIds.some((id) => streamed.has(id))) continue
      const view = remoteViewSchema.safeParse({
        projectId,
        threads: threads.map((thread) => forClients(projectId, thread)),
      })
      if (!view.success) continue
      const from: PublishedFrom = { threads, watching }
      published.set(projectId, from)
      void api.remote.publish(view.data).catch(() => {
        // Not delivered: the next change sends this project again.
        if (published.get(projectId) === from) published.delete(projectId)
      })
    }
  }

  function schedule(): void {
    if (!running || disposed) return
    // Capture now: final background bookkeeping may drop the thread before the timer fires.
    capture()
    timer ??= setTimeout(publish, 150)
  }

  /**
   * A message changed in place. Only a watched thread's transcript is sent, so
   * only a watched thread's change makes an otherwise unchanged project go again.
   */
  function messageChanged(messageId: string): void {
    if (!running || disposed) return
    const threadId = locateMessage(store, messageId)?.thread.id
    if (threadId !== undefined && [...watched.values()].some((ids) => ids.has(threadId))) {
      streamedInto.add(threadId)
    }
    schedule()
  }

  function setWatched(list: readonly RemoteWatchedThread[]): void {
    const next = new Map<string, Set<string>>()
    for (const { projectId, threadId } of list) {
      const ids = next.get(projectId) ?? new Set<string>()
      ids.add(threadId)
      next.set(projectId, ids)
    }
    watched = next
    schedule()
  }

  function setAvailability(state: Pick<MobileCompanionState, 'enabled' | 'running'>): void {
    running = state.enabled && state.running
    if (running) schedule()
    else {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // Nothing is marked while stopped, and main keeps the views it was sent,
      // so send every project again when the companion resumes.
      published.clear()
    }
  }

  const off = [
    api.mobile.onStateChanged((state) => {
      receivedState = true
      setAvailability(state)
    }),
    api.remote.onWatchedChanged((list) => {
      receivedWatched = true
      setWatched(list)
    }),
    store.on('threads_changed', schedule),
    store.on('thread_status_changed', schedule),
    store.on('message_added', schedule),
    store.on('message_token', messageChanged),
    store.on('message_reasoning', messageChanged),
    store.on('message_done', messageChanged),
    store.on('tool_call_started', messageChanged),
    store.on('tool_call_updated', messageChanged),
    store.on('todos_changed', schedule),
  ]
  void api.mobile
    .getState()
    .then((state) => {
      if (!disposed && !receivedState) setAvailability(state)
    })
    .catch(() => {})
  // A reloaded window joins clients that are already watching.
  void api.remote
    .watched()
    .then((list) => {
      if (!disposed && !receivedWatched) setWatched(list)
    })
    .catch(() => {})

  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    for (const unsubscribe of off) unsubscribe()
  }
}
