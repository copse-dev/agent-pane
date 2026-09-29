import { AsyncLocalStorage } from 'node:async_hooks'
import type { Thread } from '@shared/types'

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
}

/**
 * The async-local slot holding the current agent turn's execution context.
 * Kept in a leaf module (no runtime imports) so low-level code such as spawn
 * target resolution can read the turn's context without pulling
 * `thread-execution-context.ts`'s worktree and thread-store graph into the
 * stdout-protocol worker bundles that share it.
 */
export const threadExecutionContextStorage = new AsyncLocalStorage<ThreadExecutionContext>()

/** The current turn's context, or null outside one. */
export function currentThreadExecutionContext(): ThreadExecutionContext | null {
  return threadExecutionContextStorage.getStore() ?? null
}
