import type { ThreadArchiveResult } from '@shared/threads/archive-thread.ts'
import type { Thread } from '@shared/types/thread.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { runSerialized } from './storage/write-queue.ts'
import { getThreadMeta, updateMetaOrThrow } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { archiveThreadWorktree, type ValidateWorktreeInput } from './worktree-manager.ts'

/** Uses the dispatcher's exclusive thread slot so a turn cannot start during removal. */
export interface ThreadArchivingRuntime {
  begin(projectId: string, threadId: string): boolean
  end(projectId: string, threadId: string): void
}

export interface ThreadArchivingDependencies {
  getMeta: typeof getThreadMeta
  updateMeta: typeof updateMetaOrThrow
  projectRoot: (projectId: string) => string | null
  hasProcesses: (projectId: string, threadId: string) => boolean
  disposeAcp: (threadId: string) => Promise<unknown>
  removeWorktree: (
    input: ValidateWorktreeInput,
    discardChanges: boolean,
    beforeRemove: () => Promise<void>,
  ) => Promise<{ status: 'removed' } | { status: 'blocked-dirty'; paths: string[] }>
}

const defaultDependencies: ThreadArchivingDependencies = {
  getMeta: getThreadMeta,
  updateMeta: updateMetaOrThrow,
  projectRoot: getProjectRoot,
  hasProcesses: (projectId, threadId) =>
    hasTerminalSessions(threadId) || hasBackgroundProcessesForThread({ projectId, threadId }),
  disposeAcp: (threadId) => disposeAcpSession(threadId, { preserveForResume: true }),
  removeWorktree: archiveThreadWorktree,
}

/** Keep the conversation and its branch; reclaim only its dedicated checkout. */
export async function archiveStoredThread(
  projectId: string,
  threadId: string,
  discardChanges: boolean,
  runtime: ThreadArchivingRuntime,
  dependencies: ThreadArchivingDependencies = defaultDependencies,
): Promise<ThreadArchiveResult> {
  if (!runtime.begin(projectId, threadId)) return { status: 'blocked-running' }
  try {
    return await runSerialized(`thread-checkout:${projectId}:${threadId}`, async () => {
      const meta = await dependencies.getMeta(projectId, threadId)
      if (!meta) throw new Error('That chat is no longer available.')
      if (meta.archivedAt !== undefined) {
        return { status: 'archived', archivedAt: meta.archivedAt, worktree: meta.worktree }
      }
      if (meta.status === 'running' || dependencies.hasProcesses(projectId, threadId)) {
        return { status: 'blocked-running' }
      }

      let worktree = meta.worktree
      if (worktree) {
        const projectRoot = dependencies.projectRoot(projectId)
        if (!projectRoot) throw new Error('That project is no longer available.')
        const retiredWorktree = { ...worktree, retiredAt: worktree.retiredAt ?? Date.now() }
        const result = await dependencies.removeWorktree(
          { projectId, threadId, projectRoot, worktree },
          discardChanges,
          async () => {
            if (dependencies.hasProcesses(projectId, threadId)) {
              throw new Error(
                'Stop the chat’s terminals and background processes before archiving.',
              )
            }
            await dependencies.disposeAcp(threadId)
            await dependencies.updateMeta(projectId, threadId, { worktree: retiredWorktree })
          },
        )
        if (result.status !== 'removed') return result
        worktree = retiredWorktree
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
