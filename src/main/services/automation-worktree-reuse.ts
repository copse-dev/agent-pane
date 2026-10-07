import type { Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { getProjectThread, loadProjectThreads, updateMetaOrThrow } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { adoptThreadWorktree, canAdoptThreadWorktree } from './worktree-manager.ts'

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
  loadThreads(projectId: string): Promise<Thread[]>
  getThread(projectId: string, threadId: string): Promise<Thread | null>
  updateMeta(
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ): Promise<void>
  projectRoot(projectId: string): string | null
  /** True while a terminal, background process or ACP turn could still use the checkout. */
  isLive(projectId: string, threadId: string): boolean
  disposeSession(threadId: string): Promise<void>
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

function holdsLiveCheckout(thread: Thread): thread is Thread & { worktree: ThreadWorktree } {
  return thread.worktree !== undefined && thread.worktree.retiredAt === undefined
}

/** The schedule's most recent other run that still holds a checkout. */
function previousRun(
  threads: readonly Thread[],
  scheduleId: string,
  excluding: string,
): (Thread & { worktree: ThreadWorktree }) | null {
  const candidates = threads
    .filter(
      (thread) =>
        thread.id !== excluding &&
        thread.automation?.scheduleId === scheduleId &&
        holdsLiveCheckout(thread),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
  const latest = candidates[0]
  return latest && holdsLiveCheckout(latest) ? latest : null
}

function settled(thread: Thread): boolean {
  return thread.status !== 'running' && automationRunBlock(thread) === null
}

export function createAutomationWorktreeReuse(
  deps: AutomationWorktreeReuseDependencies,
): AutomationWorktreeReuse {
  return {
    async canReusePreviousRun(projectId, threadId): Promise<boolean> {
      const root = deps.projectRoot(projectId)
      if (!root) return false
      const threads = await deps.loadThreads(projectId)
      const subject = threads.find((thread) => thread.id === threadId)
      const scheduleId = subject?.automation?.scheduleId
      if (!subject || scheduleId === undefined) return false
      const previous = previousRun(threads, scheduleId, '')
      if (previous?.id !== threadId) return false
      if (!settled(previous) || deps.isLive(projectId, previous.id)) return false
      return deps.canAdopt({
        projectId,
        projectRoot: root,
        fromThreadId: previous.id,
        from: previous.worktree,
        baseBranch: previous.worktree.baseBranch,
      })
    },
    async reuseFor(input): Promise<ThreadWorktree | null> {
      const thread = await deps.getThread(input.projectId, input.threadId)
      const scheduleId = thread?.automation?.scheduleId
      if (!thread || scheduleId === undefined) return null
      const previous = previousRun(
        await deps.loadThreads(input.projectId),
        scheduleId,
        input.threadId,
      )
      if (!previous) return null
      if (!settled(previous) || deps.isLive(input.projectId, previous.id)) return null

      await deps.disposeSession(previous.id)
      const result = await deps.adopt({
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        fromThreadId: previous.id,
        toThreadId: input.threadId,
        from: previous.worktree,
        baseBranch: input.baseBranch,
      })
      if (result.status !== 'adopted') return null

      // The checkout now lives at the new thread's path, so the old thread must stop claiming it.
      // Its branch is the same one the new thread is on, so it is recorded as retired rather
      // than dropped. Retried once: a stale claim would break the next worktree-budget check.
      const retired = {
        worktree: {
          ...previous.worktree,
          retiredAt: deps.now(),
          retiredHead: result.previousHead,
        },
      }
      try {
        await deps.updateMeta(input.projectId, previous.id, retired)
      } catch {
        await deps.updateMeta(input.projectId, previous.id, retired)
      }
      return result.worktree
    },
  }
}

let singleton: AutomationWorktreeReuse | null = null
export function getAutomationWorktreeReuse(): AutomationWorktreeReuse {
  singleton ??= createAutomationWorktreeReuse({
    loadThreads: loadProjectThreads,
    getThread: getProjectThread,
    updateMeta: updateMetaOrThrow,
    projectRoot: getProjectRoot,
    isLive: (projectId, threadId) =>
      hasTerminalSessions(threadId) || hasBackgroundProcessesForThread({ projectId, threadId }),
    disposeSession: async (threadId) => {
      await disposeAcpSession(threadId)
    },
    canAdopt: canAdoptThreadWorktree,
    adopt: adoptThreadWorktree,
    now: Date.now,
  })
  return singleton
}
