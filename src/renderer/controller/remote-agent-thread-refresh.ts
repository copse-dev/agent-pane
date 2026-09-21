import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { REMOTE_AGENT_PROVIDER_CURSOR } from '@shared/remote-agent.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'

/**
 * Refresh a Cursor cloud agent thread's latest state on activation (issue
 * #2446).
 *
 * Reopening the editor (or switching to a thread in an already-open one) loads
 * the persisted transcript off disk and nothing else — a run that kept going,
 * or finished, on Cursor's infrastructure while Copse was not watching sat
 * indefinitely stale. This asks main to reconcile it in, once per activation:
 * main's own bookkeeping (see `refreshRemoteAgentRun` in
 * `remote-agent-client.ts`) makes the call a genuine no-op — no request at all
 * — once a run's terminal result has already been applied, so re-activating an
 * already-synced thread costs nothing.
 *
 * Mirrors {@link attachThreadHydration}'s shape: fires once for the thread the
 * app boots into, and again each time a different thread becomes active.
 */
export function attachRemoteAgentThreadRefresh(store: AppStore, api: ApiClient): () => void {
  let lastActiveThreadId: string | null = null
  /** Threads with a refresh in flight, so re-entrant activation events (this
   *  fires on every `threads_changed`, not just a thread switch) never start a
   *  second request for the same activation. */
  const inFlight = new Set<string>()

  const refreshActive = (): void => {
    const { activeThreadId } = store.getState()
    if (!activeThreadId || activeThreadId === lastActiveThreadId) return
    lastActiveThreadId = activeThreadId
    const thread = getThreadById(store, activeThreadId)
    if (
      !thread?.remoteAgentLink ||
      thread.remoteAgentLink.provider !== REMOTE_AGENT_PROVIDER_CURSOR
    ) {
      return
    }
    if (inFlight.has(activeThreadId)) return
    inFlight.add(activeThreadId)
    void api.remoteAgent
      .refreshThread(activeThreadId)
      .catch((err: unknown) => {
        console.debug('[remote-agent-refresh] refresh failed:', err)
      })
      .finally(() => {
        inFlight.delete(activeThreadId)
      })
  }

  const offThreads = store.on('threads_changed', refreshActive)
  const offWorkspace = store.on('workspace_changed', refreshActive)
  // Once at startup for whichever thread boot already restored as active.
  refreshActive()

  return () => {
    offThreads()
    offWorkspace()
  }
}
