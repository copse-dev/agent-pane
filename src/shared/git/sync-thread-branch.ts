import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, setThreadGitBranch } from '@shared/store/thread-helpers.ts'

/** True when a live checkout differs from the thread's bound branch. */
export function threadGitBranchNeedsSync(
  threadBranch: string | undefined,
  currentBranch: string | null,
): currentBranch is string {
  return Boolean(currentBranch && threadBranch !== currentBranch)
}

/** Rebind the thread to the checked-out branch when HEAD moved within the thread. */
export function syncThreadGitBranchIfChanged(
  store: AppStore,
  threadId: string,
  currentBranch: string | null,
): boolean {
  if (!currentBranch) return false
  const thread = getThreadById(store, threadId)
  if (!thread || thread.gitBranch === currentBranch) return false
  setThreadGitBranch(store, threadId, currentBranch)
  return true
}
