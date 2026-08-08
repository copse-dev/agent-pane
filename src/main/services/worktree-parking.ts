import { extractGithubPrUrls } from '@shared/git/github-pr-url.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { getThreadExecutionContext } from './thread-execution-context.ts'
import { findThreadOwners, getThreadMeta, updateMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { parkThreadWorktree } from './worktree-manager.ts'
import { registerWorktreeParkingRecheck } from './worktree-parking-events.ts'

const createdPrByThread = new Map<string, string>()

function ownerKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`
}

/** Remember a successful `gh pr create` result until its agent turn completes. */
export function recordCreatedPullRequest(command: string, output: string): void {
  if (!/(?:^|[;&|]\s*)gh\s+pr\s+create(?:\s|$)/i.test(command)) return
  const context = getThreadExecutionContext()
  if (!context || context.checkoutMode !== 'worktree') return
  const ref = extractGithubPrUrls(output)[0]
  if (!ref) return
  createdPrByThread.set(ownerKey(context.projectId, context.threadId), ref.url)
}

/**
 * Park a PR-backed checkout after a completed turn. This is deliberately
 * best-effort: cleanup must never turn a successful agent run into a failure.
 */
export async function parkCompletedPullRequestWorktree(
  projectId: string,
  threadId: string,
): Promise<void> {
  const key = ownerKey(projectId, threadId)
  const createdPrUrl = createdPrByThread.get(key)
  createdPrByThread.delete(key)

  const projectRoot = getProjectRoot(projectId)
  const meta = await getThreadMeta(projectId, threadId)
  if (!projectRoot || !meta?.worktree) return

  let worktree: ThreadWorktree = meta.worktree
  if (createdPrUrl && worktree.pullRequestUrl !== createdPrUrl) {
    worktree = { ...worktree, pullRequestUrl: createdPrUrl }
    await updateMeta(projectId, threadId, { worktree })
  }
  if (!worktree.pullRequestUrl || worktree.retiredAt !== undefined) return

  const owner = { projectId, threadId }
  if (hasTerminalSessions(threadId) || hasBackgroundProcessesForThread(owner)) return

  await disposeAcpSession(threadId)
  const result = await parkThreadWorktree({ projectId, threadId, projectRoot, worktree })
  if (result.status !== 'removed') return

  await updateMeta(projectId, threadId, {
    worktree: {
      ...worktree,
      retiredAt: Date.now(),
      retiredHead: result.head,
      upstreamRef: result.upstreamRef,
    },
  })
}

const scheduledRechecks = new Map<string, NodeJS.Timeout>()

registerWorktreeParkingRecheck((threadId) => {
  if (scheduledRechecks.has(threadId)) return
  scheduledRechecks.set(
    threadId,
    setTimeout(() => {
      scheduledRechecks.delete(threadId)
      void (async (): Promise<void> => {
        const projectIds = await findThreadOwners(threadId)
        for (const projectId of projectIds) {
          await parkCompletedPullRequestWorktree(projectId, threadId)
        }
      })().catch((error: unknown) => {
        console.warn('[worktree] Could not recheck PR-backed checkout:', error)
      })
    }, 100),
  )
})
