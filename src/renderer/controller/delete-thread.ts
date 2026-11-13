import type { AppStore } from '@shared/store/store.ts'
import { deleteThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { acknowledgeThreadDeletion, flushPendingThreadPersistence } from './persistence.ts'

/** Delete only after main's OS-owned confirmation and durable cleanup succeed. */
export async function deleteThreadAfterNativeReview(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
): Promise<void> {
  // Finish any pending create/update before deletion so it cannot land after
  // main removes the directory and silently recreate the thread.
  await flushPendingThreadPersistence()
  await api.threads.delete(projectId, threadId)
  acknowledgeThreadDeletion(projectId, threadId)
  deleteThread(store, threadId)
}
