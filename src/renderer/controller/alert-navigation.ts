import type { AppStore } from '@shared/store/store.ts'
import { getThreadProjectId } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { switchProjectThread } from './projects.ts'

export interface AlertThreadTarget {
  threadId: string
  projectId: string | null
}

/**
 * Open the thread a clicked system notification is about. Main has already
 * brought this window forward; here the window switches to the thread, which
 * also surfaces any approval or question it is waiting on.
 *
 * Main's `projectId` (from the thread store) wins when this window knows that
 * project; otherwise the renderer's own lists are asked — a brand-new thread
 * may not be on disk yet. Returns false, leaving navigation alone, when the
 * thread cannot be placed in a known project (its project was removed, say).
 */
export function openThreadFromAlert(
  store: AppStore,
  target: AlertThreadTarget,
  open: (projectId: string, threadId: string) => void,
): boolean {
  const { projects } = store.getState()
  const known =
    target.projectId !== null && projects.some((project) => project.id === target.projectId)
  const projectId = known ? target.projectId : getThreadProjectId(store, target.threadId)
  if (projectId === null) return false
  open(projectId, target.threadId)
  return true
}

/** Follow notification clicks for this main window. Returns an unsubscribe. */
export function mountAlertThreadNavigation(store: AppStore, api: ApiClient): () => void {
  return api.alerts.onOpenThread((target) => {
    openThreadFromAlert(store, target, (projectId, threadId) => {
      switchProjectThread(store, api, projectId, threadId)
    })
  })
}
