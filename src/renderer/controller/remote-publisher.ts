import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import type { Thread } from '@shared/types'
import { remoteViewSchema } from '@shared/remote-interface.ts'

/** Only an opted-in desktop owner publishes; remote clients never autosave these views. */
export function attachRemotePublisher(store: AppStore, api: ApiClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let disposed = false
  let receivedState = false
  const views = new Map<string, { projectId: string; threads: Thread[] }>()
  // Main keeps the last view it was sent for each project, so only a project
  // captured since the last publish is sent. Sending every view each time
  // re-validated and re-sent the whole transcript of every project visited this
  // session on each streamed token of any one of them.
  const unpublished = new Set<string>()

  function capture(): void {
    const { activeProjectId, threads, backgroundThreads } = store.getState()
    if (activeProjectId) {
      views.set(activeProjectId, { projectId: activeProjectId, threads })
      unpublished.add(activeProjectId)
    }
    for (const { projectId, thread } of backgroundThreads) {
      const existing = views.get(projectId)?.threads ?? []
      views.set(projectId, {
        projectId,
        threads: [...existing.filter((item) => item.id !== thread.id), thread],
      })
      unpublished.add(projectId)
    }
  }

  function publish(): void {
    timer = null
    if (!running || disposed) return
    const projectIds = [...unpublished]
    unpublished.clear()
    for (const projectId of projectIds) {
      const view = remoteViewSchema.safeParse(views.get(projectId))
      if (!view.success) continue
      void api.remote.publish(view.data).catch(() => {
        // Not delivered: send it again with the next publish.
        unpublished.add(projectId)
      })
    }
  }

  function schedule(): void {
    if (!running || disposed) return
    // Capture now: final background bookkeeping may drop the thread before the timer fires.
    capture()
    timer ??= setTimeout(publish, 150)
  }

  function setAvailability(state: Pick<MobileCompanionState, 'enabled' | 'running'>): void {
    running = state.enabled && state.running
    if (running) schedule()
    else if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const off = [
    api.mobile.onStateChanged((state) => {
      receivedState = true
      setAvailability(state)
    }),
    store.on('threads_changed', schedule),
    store.on('thread_status_changed', schedule),
    store.on('message_added', schedule),
    store.on('message_token', schedule),
    store.on('message_reasoning', schedule),
    store.on('message_done', schedule),
    store.on('tool_call_started', schedule),
    store.on('tool_call_updated', schedule),
    store.on('todos_changed', schedule),
  ]
  void api.mobile
    .getState()
    .then((state) => {
      if (!disposed && !receivedState) setAvailability(state)
    })
    .catch(() => {})

  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    for (const unsubscribe of off) unsubscribe()
  }
}
