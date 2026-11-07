import type { Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import {
  hasActiveAcpTurn,
  withIdleAcpSession,
  type IdleAcpSessionResult,
} from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { withThreadResourceFence } from './thread-resource-fence.ts'
import { getThreadMeta, loadProjectThreadMetas, updateMetaOrThrow } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { adoptThreadWorktree, canAdoptThreadWorktree } from './worktree-manager.ts'
import { hasLiveWorktreeWriter } from './worktree-writers.ts'

/**
 * Which finished run's checkout the next run of the same automation may take over.
 *
 * Only the schedule's most recent run that still holds a live checkout is ever a candidate,
 * so reuse can never skip past a newer run that is still using its own. The decision to hand it
 * on is made in three places that must agree — the trigger's worktree budget, the checkout
 * transaction, and the worktree manager — so the policy below is the single source for the first
 * two and the manager re-proves the filesystem facts under its own lock.
 */
export interface AutomationWorktreeReuseDependencies {
  /** Checkout selection needs metadata only, even when a project has large transcripts. */
  loadThreadMetas?: (projectId: string) => Promise<Omit<Thread, 'messages'>[]>
  getThreadMeta?: (projectId: string, threadId: string) => Promise<Omit<Thread, 'messages'> | null>
  updateMeta(
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ): Promise<void>
  projectRoot(projectId: string): string | null
  /** Non-ACP owners; the pool separately guards ACP ownership atomically. */
  isLive(projectId: string, threadId: string, checkoutRoot: string): boolean
  withIdleSession: <T>(
    threadId: string,
    operation: () => Promise<T>,
  ) => Promise<IdleAcpSessionResult<T>>
  canAdopt: typeof canAdoptThreadWorktree
  adopt: typeof adoptThreadWorktree
  now(): number
}

export interface AutomationWorktreeReuse {
  /**
   * Whether `threadId`'s checkout is the one the next run of its automation would take over,
   * and could be right now. Read-only; used to avoid counting a hand-over against the cap.
   */
  canReusePreviousRun(projectId: string, threadId: string): Promise<boolean>
  /** Take over the previous run's checkout for `threadId`, or return null to allocate a fresh one. */
  reuseFor(input: {
    projectId: string
    threadId: string
    projectRoot: string
    baseBranch: string
  }): Promise<ThreadWorktree | null>
}

/** A run and the checkout it still holds. */
interface HeldCheckout {
  thread: Omit<Thread, 'messages'>
  worktree: ThreadWorktree
}

/** The schedule's most recent other run that still holds a checkout. */
function previousRun(
  threads: readonly Omit<Thread, 'messages'>[],
  scheduleId: string,
  excluding: string,
): HeldCheckout | null {
  const held: HeldCheckout[] = []
  for (const thread of threads) {
    const worktree = thread.worktree
    if (
      thread.id === excluding ||
      thread.automation?.scheduleId !== scheduleId ||
      worktree === undefined ||
      worktree.retiredAt !== undefined
    )
      continue
    held.push({ thread, worktree })
  }
  held.sort((a, b) => b.thread.createdAt - a.thread.createdAt)
  return held[0] ?? null
}

function settled(thread: Omit<Thread, 'messages'>): boolean {
  return thread.status !== 'running' && automationRunBlock(thread) === null
}

export function createAutomationWorktreeReuse(
  deps: AutomationWorktreeReuseDependencies,
): AutomationWorktreeReuse {
  const loadMetas = deps.loadThreadMetas ?? loadProjectThreadMetas
  const getMeta = deps.getThreadMeta ?? getThreadMeta
  return {
    async canReusePreviousRun(projectId, threadId): Promise<boolean> {
      const root = deps.projectRoot(projectId)
      if (!root) return false
      const threads = await loadMetas(projectId)
      const subject = threads.find((thread) => thread.id === threadId)
      const scheduleId = subject?.automation?.scheduleId
      if (!subject || scheduleId === undefined) return false
      const previous = previousRun(threads, scheduleId, '')
      if (previous?.thread.id !== threadId) return false
      if (
        !settled(previous.thread) ||
        deps.isLive(projectId, threadId, previous.worktree.path) ||
        hasActiveAcpTurn(threadId)
      )
        return false
      return deps.canAdopt({
        projectId,
        projectRoot: root,
        fromThreadId: threadId,
        from: previous.worktree,
        baseBranch: previous.worktree.baseBranch,
      })
    },
    async reuseFor(input): Promise<ThreadWorktree | null> {
      const thread = await getMeta(input.projectId, input.threadId)
      const scheduleId = thread?.automation?.scheduleId
      if (!thread || scheduleId === undefined) return null
      const previous = previousRun(await loadMetas(input.projectId), scheduleId, input.threadId)
      if (!previous) return null
      return withThreadResourceFence(
        { projectId: input.projectId, threadId: previous.thread.id },
        async () => {
          // Resource creation or an earlier hand-over may have won the fence.
          const current = previousRun(await loadMetas(input.projectId), scheduleId, input.threadId)
          if (current?.thread.id !== previous.thread.id) return null
          if (
            !settled(current.thread) ||
            deps.isLive(input.projectId, current.thread.id, current.worktree.path)
          )
            return null
          const released = await deps.withIdleSession(current.thread.id, async () => {
            const latest = await getMeta(input.projectId, current.thread.id)
            if (
              !latest ||
              !settled(latest) ||
              latest.worktree?.path !== current.worktree.path ||
              latest.worktree.retiredAt !== undefined ||
              deps.isLive(input.projectId, current.thread.id, current.worktree.path)
            )
              return null
            const result = await deps.adopt({
              projectId: input.projectId,
              projectRoot: input.projectRoot,
              fromThreadId: current.thread.id,
              toThreadId: input.threadId,
              from: latest.worktree,
              baseBranch: input.baseBranch,
            })
            if (result.status !== 'adopted') return null

            // The old thread must stop claiming the checkout now owned by the
            // new run. Retry once rather than leave a stale budget claim.
            const retired = {
              worktree: {
                ...latest.worktree,
                retiredAt: deps.now(),
                retiredHead: result.previousHead,
              },
            }
            try {
              await deps.updateMeta(input.projectId, current.thread.id, retired)
            } catch {
              await deps.updateMeta(input.projectId, current.thread.id, retired)
            }
            return result.worktree
          })
          return released.status === 'busy' ? null : released.value
        },
      )
    },
  }
}

let singleton: AutomationWorktreeReuse | null = null
export function getAutomationWorktreeReuse(): AutomationWorktreeReuse {
  singleton ??= createAutomationWorktreeReuse({
    updateMeta: updateMetaOrThrow,
    projectRoot: getProjectRoot,
    isLive: (projectId, threadId, root) =>
      hasTerminalSessions(threadId) ||
      hasBackgroundProcessesForThread({ projectId, threadId }) ||
      hasLiveWorktreeWriter(root),
    withIdleSession: withIdleAcpSession,
    canAdopt: canAdoptThreadWorktree,
    adopt: adoptThreadWorktree,
    now: Date.now,
  })
  return singleton
}
