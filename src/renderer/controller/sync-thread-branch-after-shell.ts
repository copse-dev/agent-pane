import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { syncThreadGitBranchIfChanged } from '@shared/git/sync-thread-branch.ts'

/**
 * Rebind the thread if HEAD moved. Callers gate this on the foreground thread
 * running a branch-changing command (see `shellCommandMayChangeBranch`); here we
 * read the resulting branch from HEAD so `-b`/`switch -c`/detached all resolve.
 */
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
