import { it } from 'node:test'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'

export const TEST_THREAD_OWNER: ThreadExecutionOwner = {
  projectId: 'test-project',
  threadId: 'test-thread',
}

const TEST_EXECUTION_CONTEXT: ThreadExecutionContext = {
  ...TEST_THREAD_OWNER,
  projectRoot: '/test-workspace',
  root: '/test-workspace',
  checkoutMode: 'shared',
  branch: null,
}

/** Register a test whose callback executes inside a realistic agent-turn owner. */
export function ownedIt(name: string, fn: () => void | Promise<void>): void {
  void it(name, () => runWithThreadExecutionContext(TEST_EXECUTION_CONTEXT, fn))
}
