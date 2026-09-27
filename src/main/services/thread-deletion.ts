import { discardApprovalsForThread } from './approval.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { destroyTerminalSessionsForThread } from './exec/terminal-service.ts'
import { stopSupervisedBackgroundProcessesForThread } from './exec/supervised-background-process.ts'
import { clearRemoteAgentSession } from './remote/remote-agent-client.ts'
import { invalidateThreadToolCache } from './search/tool-result-cache.ts'
import { deniedOperations } from './security/denied-operations.ts'
import { clearThreadRedaction } from './security/pii-redactor.ts'
import { clearThreadReadRoots } from './security/thread-read-roots.ts'
import { clearThreadModels } from './thread-models.ts'
import { deleteProjectThread, getThreadMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import {
  retireDeletedThreadWorktree,
  type DeletedThreadWorktreeResult,
  type ValidateWorktreeInput,
} from './worktree-manager.ts'

export interface ThreadDeletionRuntime {
  /** Abort a live turn and resolve only after its final persistence has settled. */
  stopAndWaitForAgent(projectId: string, threadId: string): Promise<void>
  /** Lift the dispatch fence if cleanup fails before durable deletion. */
  resumeAfterFailedDeletion(projectId: string, threadId: string): void
  /** Drop dispatcher-owned provider history after the run has stopped. */
  forgetAgentHistory(projectId: string, threadId: string): void
}

export interface ThreadDeletionDependencies {
  cancelApprovals(threadId: string): void
  disposeAcp(threadId: string): Promise<unknown>
  destroyTerminals(threadId: string): Promise<unknown>
  stopBackgroundProcesses(owner: { projectId: string; threadId: string }): Promise<unknown>
  /** The thread's live linked checkout, or null when it runs in the shared project checkout. */
  findWorktree(projectId: string, threadId: string): Promise<ValidateWorktreeInput | null>
  /** Remove a linked checkout only when that loses nothing; otherwise report why it stays. */
  retireWorktree(input: ValidateWorktreeInput): Promise<DeletedThreadWorktreeResult>
  clearRemoteSession(threadId: string): void
  clearRedaction(threadId: string): void
  clearModels(threadId: string): void
  clearReadRoots(threadId: string): void
  clearToolCache(threadId: string): void
  clearDeniedOperations(threadId: string): void
  deleteStore(projectId: string, threadId: string): Promise<void>
}

async function findThreadWorktree(
  projectId: string,
  threadId: string,
): Promise<ValidateWorktreeInput | null> {
  const worktree = (await getThreadMeta(projectId, threadId))?.worktree
  // A retired checkout (merged, or parked behind its pushed PR branch) is
  // already off disk; the branch it left behind is not this deletion's to touch.
  if (!worktree || worktree.retiredAt !== undefined) return null
  const projectRoot = getProjectRoot(projectId)
  if (!projectRoot) return null
  return { projectId, threadId, projectRoot, worktree }
}

const defaultDependencies: ThreadDeletionDependencies = {
  cancelApprovals: (threadId) => {
    discardApprovalsForThread(threadId)
  },
  disposeAcp: disposeAcpSession,
  destroyTerminals: destroyTerminalSessionsForThread,
  stopBackgroundProcesses: stopSupervisedBackgroundProcessesForThread,
  findWorktree: findThreadWorktree,
  retireWorktree: retireDeletedThreadWorktree,
  clearRemoteSession: clearRemoteAgentSession,
  clearRedaction: clearThreadRedaction,
  clearModels: clearThreadModels,
  clearReadRoots: clearThreadReadRoots,
  clearToolCache: invalidateThreadToolCache,
  clearDeniedOperations: (threadId) => {
    deniedOperations.clearThread(threadId)
  },
  deleteStore: deleteProjectThread,
}

/**
 * Remove the thread's linked checkout when that is provably safe.
 *
 * This step never fails deletion. Its only fallback is to leave the checkout
 * where it is — what deletion always did before this step existed — and a
 * retained checkout then appears as an orphan in Settings → Storage →
 * Worktrees, which owns the confirmed removal of dirty or unmerged work.
 * Aborting instead would make a thread undeletable whenever its checkout is
 * already gone, its project has moved, or Git is unavailable, and no retry
 * could repair any of those.
 * Continuing loses nothing: the manager removes a checkout only after proving
 * there is nothing in it to lose.
 */
async function retireWorktreeIfSafe(
  projectId: string,
  threadId: string,
  dependencies: ThreadDeletionDependencies,
): Promise<void> {
  try {
    const worktree = await dependencies.findWorktree(projectId, threadId)
    if (!worktree) return
    const result = await dependencies.retireWorktree(worktree)
    if (result.status !== 'removed') {
      console.info(
        `[thread-deletion] Kept the thread's worktree (${result.status}); it is listed in Settings → Storage → Worktrees`,
      )
    }
  } catch (error) {
    console.warn("[thread-deletion] Could not retire the thread's worktree; keeping it:", error)
  }
}

/**
 * Retire process-owned resources before deleting their durable owner.
 *
 * Every step is idempotent. If cleanup fails, the thread store remains so a
 * retry can finish instead of leaving live work attached to an absent thread.
 */
export async function deleteThreadResourcesAndStore(
  projectId: string,
  threadId: string,
  runtime: ThreadDeletionRuntime,
  dependencies: ThreadDeletionDependencies = defaultDependencies,
): Promise<void> {
  let storeDeletionStarted = false
  try {
    dependencies.cancelApprovals(threadId)
    await runtime.stopAndWaitForAgent(projectId, threadId)
    await dependencies.disposeAcp(threadId)
    await dependencies.destroyTerminals(threadId)
    await dependencies.stopBackgroundProcesses({ projectId, threadId })
    // By now nothing the thread started is still running inside its checkout.
    await retireWorktreeIfSafe(projectId, threadId, dependencies)

    dependencies.clearRemoteSession(threadId)
    dependencies.clearRedaction(threadId)
    dependencies.clearModels(threadId)
    dependencies.clearReadRoots(threadId)
    dependencies.clearToolCache(threadId)
    dependencies.clearDeniedOperations(threadId)
    runtime.forgetAgentHistory(projectId, threadId)

    storeDeletionStarted = true
    await dependencies.deleteStore(projectId, threadId)
  } catch (error) {
    if (!storeDeletionStarted) runtime.resumeAfterFailedDeletion(projectId, threadId)
    throw error
  }
}
