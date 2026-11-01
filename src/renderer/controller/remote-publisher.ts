import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import { remoteViewSchema } from '@shared/remote-interface.ts'

/** Only an opted-in desktop owner publishes; remote clients never autosave these views. */
export function attachRemotePublisher(store: AppStore, api: ApiClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let disposed = false
  let receivedState = false

  function publish(): void {
    timer = null
    if (!running || disposed) return
    const { activeProjectId, threads } = store.getState()
    if (!activeProjectId) return
    const view = remoteViewSchema.safeParse({ projectId: activeProjectId, threads })
    if (view.success) void api.remote.publish(view.data).catch(() => {})
  }

  function schedule(): void {
    if (running && !disposed && timer === null) timer = setTimeout(publish, 150)
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
