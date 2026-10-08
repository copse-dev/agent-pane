import { extractGithubPrUrls } from '@shared/git/github-pr-url.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { getThreadExecutionContext } from './thread-execution-context.ts'
import { findThreadOwners, getThreadMeta, updateMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import type { AutomationRetainedReason } from '@shared/types/automations.ts'
import {
  MissingThreadWorktreeError,
  parkThreadWorktree,
  retireThreadWorktree,
} from './worktree-manager.ts'
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

export type AutomationWorktreeRelease =
  | { released: true }
  | { released: false; reason: AutomationRetainedReason; paths?: string[] }

const RELEASED: AutomationWorktreeRelease = { released: true }

/** How many changed paths a release block carries for display. */
const MAX_REPORTED_PATHS = 5

/**
 * Make a completed automation checkout eligible for its next fresh run.
 * Read-only runs disappear immediately; a checkout with uncommitted changes
 * or unmerged commits is kept and blocks replacement so a schedule can never
 * leak an unbounded trail of worktrees behind work that still needs a human
 * decision. Git-ignored files (build output, dependencies) are regenerable
 * and do not count as work. A checkout already gone from disk holds nothing,
 * so it is released rather than failing every later run.
 */
export async function releaseCompletedAutomationWorktree(
  projectId: string,
  threadId: string,
): Promise<AutomationWorktreeRelease> {
  const projectRoot = getProjectRoot(projectId)
  const meta = await getThreadMeta(projectId, threadId)
  if (!projectRoot || !meta?.automation) return { released: false, reason: 'in-use' }
  const worktree = meta.worktree
  if (!worktree || worktree.retiredAt !== undefined) return RELEASED

  const owner = { projectId, threadId }
  if (hasTerminalSessions(threadId) || hasBackgroundProcessesForThread(owner)) {
    return { released: false, reason: 'in-use' }
  }

  await disposeAcpSession(threadId)
  try {
    if (worktree.pullRequestUrl) {
      const result = await parkThreadWorktree({ projectId, threadId, projectRoot, worktree })
      if (result.status === 'blocked-dirty') {
        return {
          released: false,
          reason: 'uncommitted-changes',
          paths: result.paths.slice(0, MAX_REPORTED_PATHS),
        }
      }
      if (result.status !== 'removed') return { released: false, reason: 'unpushed-pull-request' }
      await updateMeta(projectId, threadId, {
        worktree: {
          ...worktree,
          retiredAt: Date.now(),
          retiredHead: result.head,
          upstreamRef: result.upstreamRef,
        },
      })
      return RELEASED
    }

    const result = await retireThreadWorktree(
      { projectId, threadId, projectRoot, worktree },
      { ignoreIgnoredFiles: true },
    )
    if (result.status === 'blocked-dirty') {
      return {
        released: false,
        reason: 'uncommitted-changes',
        paths: result.paths.slice(0, MAX_REPORTED_PATHS),
      }
    }
    if (result.status !== 'removed') return { released: false, reason: 'unmerged-commits' }
  } catch (error) {
    if (!(error instanceof MissingThreadWorktreeError)) throw error
  }
  await updateMeta(projectId, threadId, {
    worktree: { ...worktree, retiredAt: Date.now() },
  })
  return RELEASED
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
