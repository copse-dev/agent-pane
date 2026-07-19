import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getThreadExecutionContext,
  requireThreadExecutionContext,
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
  type ThreadExecutionContextDependencies,
} from './thread-execution-context.ts'

function sharedContext(threadId: string, root: string): ThreadExecutionContext {
  return {
    projectId: 'project-1',
    threadId,
    projectRoot: root,
    root,
    checkoutMode: 'shared',
    branch: 'main',
  }
}

function resolver(
  overrides: Partial<ThreadExecutionContextDependencies> = {},
): ThreadExecutionContext {
  const dependencies: ThreadExecutionContextDependencies = {
    getActiveProjectId: () => 'project-1',
    getProjectRoot: () => '/project',
    ...overrides,
  }
  return resolveThreadExecutionContext('thread-1', dependencies)
}

describe('thread execution context', () => {
  it('is absent outside an agent run', () => {
    assert.equal(getThreadExecutionContext(), null)
    assert.throws(() => requireThreadExecutionContext(), /No thread execution context/)
  })

  it('resolves shared mode from the active persisted project', () => {
    const context = resolver()

    assert.deepEqual(context, {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      root: '/project',
      checkoutMode: 'shared',
      branch: null,
    })
    assert.equal(Object.isFrozen(context), true)
  })

  it('rejects a missing active project or persisted project root', () => {
    assert.throws(() => resolver({ getActiveProjectId: () => null }), /active project/)
    assert.throws(() => resolver({ getProjectRoot: () => null }), /Cannot resolve root/)
  })

  it('keeps simultaneous thread roots isolated across awaits', async () => {
    let releaseFirst: (() => void) | undefined
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted: (() => void) | undefined
    const firstIsRunning = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const first = runWithThreadExecutionContext(sharedContext('thread-1', '/one'), async () => {
      firstStarted?.()
      await firstCanFinish
      return requireThreadExecutionContext()
    })
    await firstIsRunning

    const second = await runWithThreadExecutionContext(
      sharedContext('thread-2', '/two'),
      async () => {
        await Promise.resolve()
        return requireThreadExecutionContext()
      },
    )
    releaseFirst?.()

    assert.equal(second.threadId, 'thread-2')
    assert.equal(second.root, '/two')
    assert.equal((await first).threadId, 'thread-1')
    assert.equal((await first).root, '/one')
    assert.equal(getThreadExecutionContext(), null)
  })
})
