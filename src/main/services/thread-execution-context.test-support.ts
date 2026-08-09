import { it } from 'node:test'
import {
  runWithThreadExecutionContext,
  type ThreadCheckoutMode,
  type ThreadExecutionContext,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'
import { getWorkspaceRoot } from './workspace.ts'

export const TEST_THREAD_OWNER: ThreadExecutionOwner = {
  projectId: 'test-project',
  threadId: 'test-thread',
}

/**
 * Register a test whose callback executes inside a realistic agent-turn owner.
 *
 * `checkoutMode` defaults to `'shared'` — the mode most services see, and the one
 * whose behaviour must not shift when a worktree-only path is added. Pass
 * `'worktree'` for the isolated-checkout half; the root stays the same temp dir
 * either way, since the tests that care are asserting on policy, not on where the
 * manager would have placed a real worktree.
 */
export function ownedIt(
  name: string,
  fn: () => void | Promise<void>,
  { checkoutMode = 'shared' }: { checkoutMode?: ThreadCheckoutMode } = {},
): void {
  void it(name, () => {
    const root = getWorkspaceRoot() ?? '/test-workspace'
    const context: ThreadExecutionContext = {
      ...TEST_THREAD_OWNER,
      projectRoot: root,
      root,
      checkoutMode,
      branch: null,
    }
    return runWithThreadExecutionContext(context, fn)
  })
}

/** {@link ownedIt} bound to a thread running in its own isolated worktree. */
export function worktreeIt(name: string, fn: () => void | Promise<void>): void {
  ownedIt(name, fn, { checkoutMode: 'worktree' })
}
