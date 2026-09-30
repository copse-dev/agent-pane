import { archiveThread } from '@shared/store/thread-helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { showToast } from '../views/toast.ts'

/**
 * Mirror the main process's auto-archive sweep (#3330) into the open project.
 *
 * Main has already stamped `archivedAt` on disk; this only brings the in-memory
 * thread list along so the rows leave the sidebar without a reload, and moves the
 * selection off a thread that was archived while it was open. Other projects are
 * not loaded here — they read the stamp from disk the next time they open.
 */
export function attachAutoArchiveFollow(store: AppStore, api: ApiClient): () => void {
  return api.threads.onAutoArchived((projectId, threadIds) => {
    if (projectId !== store.getState().activeProjectId) return
    let archived = 0
    for (const id of threadIds) {
      if (!store.getState().threads.some((t) => t.id === id && t.archivedAt == null)) continue
      archiveThread(store, id)
      archived += 1
    }
    if (archived > 0) {
      showToast(`Archived ${String(archived)} merged thread${archived === 1 ? '' : 's'}.`)
    }
  })
}
