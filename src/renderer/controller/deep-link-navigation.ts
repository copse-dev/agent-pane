import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { switchProjectThread } from './projects.ts'
import { showToast } from '../views/toast.ts'

export function openDeepLinkThread(
  store: AppStore,
  target: { threadId: string; projectId: string | null },
  open: (projectId: string, threadId: string) => void,
): boolean {
  const { threadId, projectId } = target
  if (projectId === null || !store.getState().projects.some((p) => p.id === projectId)) return false
  open(projectId, threadId)
  return true
}

export function mountDeepLinkNavigation(store: AppStore, api: ApiClient): () => void {
  return api.deepLinks.onOpenThread((target) => {
    if (
      !openDeepLinkThread(store, target, (projectId, threadId) => {
        switchProjectThread(store, api, projectId, threadId)
      })
    ) {
      showToast(
        'Thread not found on this device. Open the link in the Copse profile that created it.',
      )
    }
  })
}
