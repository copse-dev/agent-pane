import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { StagedDiffEntry } from '@shared/types/state.ts'
import { syncFilesPaneDom } from './panels.ts'

/**
 * Mirror the main process's proposed-diff queue into the renderer store.
 *
 * Extracted from the agent controller because a pane pop-out window needs this
 * wiring without the rest of it: `main.ts` deliberately skips
 * `startAgentController` in pop-out mode so the main window keeps sole ownership
 * of the agent loop, which left the detached Changes pane with a permanently
 * empty `stagedDiffs` and therefore no "Proposed" section at all (#1704).
 *
 * `diff:queued` is a push, so any renderer that boots (or switches thread)
 * mid-run misses everything staged before it attached. `hydrate` closes that gap
 * by pulling the queue the main process still holds.
 */
export interface DiffStateOptions {
  /**
   * Open the Changes panel when a diff is proposed. The main window does this so
   * a proposal surfaces itself; a pop-out is already pinned to one pane, so it
   * only records the payload.
   */
  revealOnShowDiff: boolean
}

/**
 * Identity of a queue snapshot, so hydration can skip a no-op republish.
 */
function queueKey(entries: StagedDiffEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.path, entry.language]))
}

export function attachDiffState(
  store: AppStore,
  api: ApiClient,
  options: DiffStateOptions,
): () => void {
  const queuesByOwner = new Map<string, StagedDiffEntry[]>()
  const ownerKey = (projectId: string, threadId: string): string =>
    JSON.stringify([projectId, threadId])
  const isActiveOwner = (projectId: string, threadId: string): boolean => {
    const current = store.getState()
    return current.activeProjectId === projectId && current.activeThreadId === threadId
  }

  const publishActiveQueue = (entries: StagedDiffEntry[]): void => {
    const { activeDiff } = store.getState()
    const stillQueued =
      activeDiff && entries.some((entry) => entry.path === activeDiff.path) ? activeDiff : null
    store.setState({
      stagedDiffs: entries,
      activeDiff: entries.length === 0 ? null : stillQueued,
    })
    // `agent:show_diff` owns opening Changes and arrives before this queue in
    // the real edit path. A queue-only update is metadata: forcing the panel
    // open here makes background/deferred proposals construct Monaco while the
    // user is still watching another surface.
    store.emit('staged_diffs_changed')
    store.emit('panel_changed')
  }

  const unsubShowDiff = api.diff.onShowDiff(
    (projectId, threadId, path, before, after, language) => {
      if (!isActiveOwner(projectId, threadId)) return
      store.setState({ activeDiff: { path, before, after, language } })
      if (!options.revealOnShowDiff) return
      store.setState({ rightPanelMode: 'changes', filesPaneOpen: true })
      // Layout first (unhide pane + Changes hosts), then tell the pane to sync.
      syncFilesPaneDom(store)
      store.emit('right_panel_mode_changed')
      store.emit('files_pane_changed')
      store.emit('panel_changed')
    },
  )

  const unsubQueued = api.diff.onQueued((projectId, threadId, entries) => {
    queuesByOwner.set(ownerKey(projectId, threadId), entries)
    if (isActiveOwner(projectId, threadId)) publishActiveQueue(entries)
  })

  /**
   * Pull the queue for the current thread. Guarded on the owner still being
   * active when the read returns so a fast thread switch cannot publish the
   * previous thread's queue over the new one.
   */
  const hydrate = (): void => {
    const { activeProjectId, activeThreadId } = store.getState()
    if (!activeProjectId || !activeThreadId) return
    void (async (): Promise<void> => {
      let entries: StagedDiffEntry[]
      try {
        entries = await api.diff.queue(activeProjectId, activeThreadId)
      } catch {
        return
      }
      if (!isActiveOwner(activeProjectId, activeThreadId)) return
      queuesByOwner.set(ownerKey(activeProjectId, activeThreadId), entries)
      // Hydration usually confirms what the store already holds. Publishing that
      // anyway emits `staged_diffs_changed` on every boot and thread switch, and
      // the Changes pane answers it with a git refresh.
      if (queueKey(store.getState().stagedDiffs) === queueKey(entries)) return
      publishActiveQueue(entries)
    })()
  }

  let publishedOwnerKey = ownerKey(
    store.getState().activeProjectId ?? '',
    store.getState().activeThreadId ?? '',
  )
  const syncDiffOwner = (): void => {
    const { activeProjectId, activeThreadId } = store.getState()
    const nextOwnerKey = ownerKey(activeProjectId ?? '', activeThreadId ?? '')
    if (nextOwnerKey === publishedOwnerKey) return
    publishedOwnerKey = nextOwnerKey
    const entries =
      activeProjectId && activeThreadId
        ? (queuesByOwner.get(ownerKey(activeProjectId, activeThreadId)) ?? [])
        : []
    publishActiveQueue(entries)
    // The cached queue can be stale (or absent) for a thread this renderer has
    // not seen staged before — re-read the authoritative one.
    hydrate()
  }
  const unsubWorkspace = store.on('workspace_changed', syncDiffOwner)
  const unsubThreads = store.on('threads_changed', syncDiffOwner)

  hydrate()

  return () => {
    unsubShowDiff()
    unsubQueued()
    unsubWorkspace()
    unsubThreads()
  }
}
