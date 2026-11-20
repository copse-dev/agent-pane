import { sameItems, type AppStore } from '@shared/store/store.ts'
import type { AppState } from '@shared/types/state.ts'

/** The project this window has selected, and the root main serves for it. */
export type ActiveWorkspace = readonly [
  activeProjectId: AppState['activeProjectId'],
  workspaceRoot: AppState['workspaceRoot'],
]

function activeWorkspace(state: AppState): ActiveWorkspace {
  return [state.activeProjectId, state.workspaceRoot]
}

/**
 * Call `listener` after any `setState` that selects another project or points
 * this window at another root. Not called on subscribe.
 *
 * Both fields count. Quarantining a missing project names its successor before
 * `restoreProject` opens the successor's root, so a view that reads
 * workspace-scoped data from main has to hear the root change too. Otherwise
 * it would load once against the old root and never again.
 */
export function selectActiveWorkspace(
  store: AppStore,
  listener: (next: ActiveWorkspace, prev: ActiveWorkspace) => void,
): () => void {
  return store.select(activeWorkspace, listener, sameItems)
}
