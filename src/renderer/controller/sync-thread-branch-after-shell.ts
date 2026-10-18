import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { syncThreadGitBranchIfChanged } from '@shared/git/sync-thread-branch.ts'
import { isUnavailableThreadCheckoutError } from '../ipc-error-message.ts'

/**
 * Rebind the thread if HEAD moved. Callers gate this on the foreground thread:
 * mid-turn after a branch-changing `run_shell` command (see
 * `shellCommandMayChangeBranch`) and once at turn end, which also catches
 * checkouts by external ACP agents whose tool calls we can't inspect. Reading
 * the resulting branch from HEAD means `-b`/`switch -c`/detached all resolve.
 */
export async function syncThreadGitBranchAfterShell(
  store: AppStore,
  api: ApiClient,
  threadId: string,
): Promise<void> {
  const projectId = store.getState().activeProjectId
  if (!projectId) return
  let currentBranch: string | null
  try {
    ;({ currentBranch } = await api.git.branchStatus(projectId, threadId))
  } catch (error) {
    // The agent's failure already explains these states. This supplementary
    // refresh must not turn that recoverable refusal into an unhandled toast.
    if (!isUnavailableThreadCheckoutError(error)) throw error
    return
  }
  if (syncThreadGitBranchIfChanged(store, threadId, currentBranch)) {
    store.emit('git_branch_changed')
  }
}
