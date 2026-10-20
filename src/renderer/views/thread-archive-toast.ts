import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { restoreArchivedThread } from '../controller/thread-archive.ts'
import { showErrorToast, showToast } from './toast.ts'

export function showThreadArchiveToast(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
  title: string,
): void {
  showToast(`Archived “${title}”. Find it in the Archived filter.`, {
    durationMs: 15_000,
    action: {
      label: 'Undo',
      onClick: () => {
        void restoreArchivedThread(store, api, projectId, threadId).catch((error: unknown) => {
          showErrorToast('Could not restore thread', error)
        })
      },
    },
  })
}
