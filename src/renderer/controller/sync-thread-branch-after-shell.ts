import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { syncThreadGitBranchIfChanged } from '@shared/git/sync-thread-branch.ts'

/** After a successful shell command, rebind the thread if HEAD moved. */
export async function syncThreadGitBranchAfterShell(
  store: AppStore,
  api: ApiClient,
  threadId: string,
): Promise<void> {
  const { currentBranch } = await api.git.branchStatus()
  if (syncThreadGitBranchIfChanged(store, threadId, currentBranch)) {
    store.emit('git_branch_changed')
  }
}
