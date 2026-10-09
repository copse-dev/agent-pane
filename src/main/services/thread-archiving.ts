import type { ThreadArchiveResult, ThreadLiveResources } from '@shared/threads/archive-thread.ts'
import type { Thread } from '@shared/types/thread.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { stopSupervisedBackgroundProcessesForThread } from './exec/supervised-background-process.ts'
import { destroyTerminalSessionsForThread, hasTerminalSessions } from './exec/terminal-service.ts'
import { withThreadResourceFence } from './thread-resource-fence.ts'
import { getThreadMeta, updateMetaOrThrow } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { archiveThreadWorktree } from './worktree-manager.ts'

/** Uses the dispatcher's exclusive thread slot so a turn cannot start during removal. */
export interface ThreadArchivingRuntime {
  begin(projectId: string, threadId: string): boolean
  end(projectId: string, threadId: string): void
  isAgentActive(projectId: string, threadId: string): boolean
  /** Abort a live turn and resolve only after its final persistence has settled. */
  stopAgent(projectId: string, threadId: string): Promise<void>
}

export interface ThreadArchivingDependencies {
  getMeta: typeof getThreadMeta
  updateMeta: typeof updateMetaOrThrow
  projectRoot: (projectId: string) => string | null
  hasTerminals: (threadId: string) => boolean
  hasBackgroundProcesses: (projectId: string, threadId: string) => boolean
  destroyTerminals: (threadId: string) => Promise<unknown>
  stopBackgroundProcesses: (owner: { projectId: string; threadId: string }) => Promise<unknown>
  disposeAcp: (threadId: string) => Promise<unknown>
  removeWorktree: typeof archiveThreadWorktree
}

const defaultDependencies: ThreadArchivingDependencies = {
  getMeta: getThreadMeta,
  updateMeta: updateMetaOrThrow,
  projectRoot: getProjectRoot,
  hasTerminals: hasTerminalSessions,
  hasBackgroundProcesses: (projectId, threadId) =>
    hasBackgroundProcessesForThread({ projectId, threadId }),
  destroyTerminals: destroyTerminalSessionsForThread,
  stopBackgroundProcesses: stopSupervisedBackgroundProcessesForThread,
  disposeAcp: (threadId) => disposeAcpSession(threadId, { preserveForResume: true }),
  removeWorktree: archiveThreadWorktree,
}

function anyLive(running: ThreadLiveResources): boolean {
  return running.agent || running.terminals || running.backgroundProcesses
}

/**
 * Archive a chat. Live work is never stopped implicitly: without `stopProcesses`
 * the caller gets `blocked-running` naming what is alive and can ask the user.
 * With it, the agent turn, ACP session, terminals and background processes are
 * stopped and awaited before the first inspection of the checkout, so nothing
 * of ours can write into it while the user decides what to discard.
 */
export async function archiveStoredThread(
  projectId: string,
  threadId: string,
  confirmation: string | null,
  stopProcesses: boolean,
  runtime: ThreadArchivingRuntime,
  dependencies: ThreadArchivingDependencies = defaultDependencies,
): Promise<ThreadArchiveResult> {
  const live = async (): Promise<ThreadLiveResources> => {
    const meta = await dependencies.getMeta(projectId, threadId)
    return {
      agent: meta?.status === 'running' || runtime.isAgentActive(projectId, threadId),
      terminals: dependencies.hasTerminals(threadId),
      backgroundProcesses: dependencies.hasBackgroundProcesses(projectId, threadId),
    }
  }
  const owner = { projectId, threadId }

  if (stopProcesses) await runtime.stopAgent(projectId, threadId)
  else {
    const running = await live()
    if (anyLive(running)) return { status: 'blocked-running', running }
  }
  if (!runtime.begin(projectId, threadId)) {
    return { status: 'blocked-running', running: await live() }
  }
  try {
    return await withThreadResourceFence(owner, async () => {
      const meta = await dependencies.getMeta(projectId, threadId)
      if (!meta) throw new Error('That chat is no longer available.')
      if (meta.archivedAt !== undefined) {
        return { status: 'archived', archivedAt: meta.archivedAt, worktree: meta.worktree }
      }
      if (stopProcesses) {
        await dependencies.disposeAcp(threadId)
        await dependencies.destroyTerminals(threadId)
        await dependencies.stopBackgroundProcesses(owner)
      }
      const running = await live()
      if (anyLive(running)) return { status: 'blocked-running', running }

      let worktree = meta.worktree
      if (worktree) {
        const projectRoot = dependencies.projectRoot(projectId)
        if (!projectRoot) throw new Error('That project is no longer available.')
        const originalWorktree = worktree
        const retiredAt = worktree.retiredAt ?? Date.now()
        const result = await dependencies.removeWorktree(
          { projectId, threadId, projectRoot, worktree },
          confirmation,
          async (validated) => {
            const retiredWorktree = { ...validated, retiredAt }
            if (anyLive(await live())) {
              throw new Error(
                'Stop the chat’s agent, terminals and background processes before archiving.',
              )
            }
            await dependencies.disposeAcp(threadId)
            await dependencies.updateMeta(projectId, threadId, {
              worktree: retiredWorktree,
              gitBranch: retiredWorktree.branch,
            })
            return async (): Promise<void> => {
              await dependencies.updateMeta(projectId, threadId, {
                worktree: originalWorktree,
                gitBranch: originalWorktree.branch,
              })
            }
          },
        )
        if (result.status !== 'removed') {
          return result
        }
        worktree = { ...result.worktree, retiredAt }
      }
      const archivedAt = Date.now()
      const patch: Partial<Omit<Thread, 'messages'>> = { archivedAt, updatedAt: archivedAt }
      await dependencies.updateMeta(projectId, threadId, patch)
      return { status: 'archived', archivedAt, worktree }
    })
  } finally {
    runtime.end(projectId, threadId)
  }
}
