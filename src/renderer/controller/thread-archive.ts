import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { switchProjectThread } from './projects.ts'
import { invalidateProjectThreadLoads, loadPersistedThread } from './persistence.ts'

/** Restore through main before making the thread selectable in this renderer. */
export async function restoreArchivedThread(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
): Promise<void> {
  if (!(await api.threads.archiveDecision(projectId, threadId, 'restore')))
    throw new Error('The thread is busy or changed. Try restoring it again.')
  invalidateProjectThreadLoads(api, projectId)
  if (store.getState().activeProjectId === projectId) {
    const metadata = await loadPersistedThread(api, projectId, threadId)
    if (!metadata) throw new Error('The restored thread could not be loaded.')
    if (store.getState().activeProjectId === projectId) {
      const threads = store.getState().threads
      const previous = threads.find((thread) => thread.id === threadId)
      const restored =
        previous?.messagesLoaded !== false && previous
          ? { ...metadata, messages: previous.messages, messagesLoaded: true }
          : metadata
      // Main already owns this thread. Register its metadata before notifying
      // autosave, which would otherwise recreate it with an unloaded transcript.
      store.setState({ threads: [...threads.filter((thread) => thread.id !== threadId), restored] })
      store.emit('threads_changed')
    }
  }
  switchProjectThread(store, api, projectId, threadId)
}
