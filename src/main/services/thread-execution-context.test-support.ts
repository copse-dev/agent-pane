import { it } from 'node:test'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'
import { getWorkspaceRoot } from './workspace.ts'

export const TEST_THREAD_OWNER: ThreadExecutionOwner = {
  projectId: 'test-project',
  threadId: 'test-thread',
}

/** Register a test whose callback executes inside a realistic agent-turn owner. */
export function ownedIt(name: string, fn: () => void | Promise<void>): void {
  void it(name, () => {
    const root = getWorkspaceRoot() ?? '/test-workspace'
    const context: ThreadExecutionContext = {
      ...TEST_THREAD_OWNER,
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }
    return runWithThreadExecutionContext(context, fn)
  })
}
