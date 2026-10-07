import { AsyncLocalStorage } from 'node:async_hooks'
import type { Thread } from '@shared/types'
import type { ThreadDeferredWorktree } from '@shared/types/worktree.ts'

export type ThreadCheckoutMode = 'shared' | 'worktree'

/** Trusted main-process identity and filesystem root for one agent turn. */
export interface ThreadExecutionContext {
  readonly projectId: string
  readonly threadId: string
  readonly projectRoot: string
  readonly root: string
  readonly checkoutMode: ThreadCheckoutMode
  readonly branch: string | null
  /**
   * Renderer-visible schedule claim from thread metadata. Permission consumers
   * must corroborate it against main-owned automation state before trusting it.
   */
  readonly automation?: NonNullable<Thread['automation']>
  /**
   * Present while an `on-write` thread has not allocated its worktree yet. The
   * context is then a read-only view of the project checkout (`checkoutMode`
   * is `shared`, `root` is `projectRoot`): tools that may write must first
   * allocate through `ensureWritableThreadCheckout`, which swaps this turn onto
   * the new worktree.
   */
  readonly deferredWorktree?: ThreadDeferredWorktree
}

/**
 * The async-local slot holding the current agent turn's execution context.
 * Kept in a leaf module (no runtime imports) so low-level code such as spawn
 * target resolution can read the turn's context without pulling
 * `thread-execution-context.ts`'s worktree and thread-store graph into the
 * stdout-protocol worker bundles that share it.
 */
export const threadExecutionContextStorage = new AsyncLocalStorage<ThreadExecutionContext>()

// A deferred (read-only) turn that allocates its worktree mid-turn cannot
// rebind the AsyncLocal store: `run` inside a tool does not reach the caller's
// chain, and the loop, subagents, and the ACP bridge each hold their own bound
// copy. Every bound copy that is still deferred resolves through this map
// instead, so all readers — including this leaf's — move to the worktree at the
// same instant. Entries are only consulted for deferred contexts, and a thread
// never becomes deferred again once it owns a worktree, so a stale entry cannot
// misroute. Kept here, beside the store, so no reader can bypass it.
const upgradedContexts = new Map<string, ThreadExecutionContext>()

function upgradeKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`
}

/** Record the worktree context a deferred turn allocated mid-turn. */
export function setUpgradedThreadExecutionContext(context: ThreadExecutionContext): void {
  upgradedContexts.set(upgradeKey(context.projectId, context.threadId), context)
}

/** Forget a turn's upgrade once the turn that performed it has finished. */
export function clearUpgradedThreadExecutionContext(owner: {
  readonly projectId: string
  readonly threadId: string
}): void {
  upgradedContexts.delete(upgradeKey(owner.projectId, owner.threadId))
}

/** The current turn's context, or null outside one. */
export function currentThreadExecutionContext(): ThreadExecutionContext | null {
  const bound = threadExecutionContextStorage.getStore()
  if (!bound) return null
  if (!bound.deferredWorktree) return bound
  return upgradedContexts.get(upgradeKey(bound.projectId, bound.threadId)) ?? bound
}
