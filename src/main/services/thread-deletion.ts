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
import { deleteProjectThread } from './thread-store.ts'

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
  clearRemoteSession(threadId: string): void
  clearRedaction(threadId: string): void
  clearModels(threadId: string): void
  clearReadRoots(threadId: string): void
  clearToolCache(threadId: string): void
  clearDeniedOperations(threadId: string): void
  deleteStore(projectId: string, threadId: string): Promise<void>
}

const defaultDependencies: ThreadDeletionDependencies = {
  cancelApprovals: (threadId) => {
    discardApprovalsForThread(threadId)
  },
  disposeAcp: disposeAcpSession,
  destroyTerminals: destroyTerminalSessionsForThread,
  stopBackgroundProcesses: stopSupervisedBackgroundProcessesForThread,
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
