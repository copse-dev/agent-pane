import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getThreadExecutionContext,
  prepareThreadExecutionContext,
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
): Promise<ThreadExecutionContext> {
  const dependencies: ThreadExecutionContextDependencies = {
    getProjectRoot: () => '/project',
    getThreadMeta: async () => ({ id: 'thread-1' }),
    ...overrides,
  }
  return resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
}

describe('thread execution context', () => {
  it('is absent outside an agent run', () => {
    assert.equal(getThreadExecutionContext(), null)
    assert.throws(() => requireThreadExecutionContext(), /No thread execution context/)
  })

  it('resolves shared mode from an explicitly selected persisted project/thread pair', async () => {
    const context = await resolver()

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

  it('rejects a missing persisted project root', async () => {
    await assert.rejects(resolver({ getProjectRoot: () => null }), /Cannot resolve root/)
  })

  it('rejects a thread that is not persisted under the selected project', async () => {
    await assert.rejects(
      resolver({ getThreadMeta: async () => null }),
      /does not belong to project/,
    )
  })

  it('emits a terminal stream when identity setup fails', async () => {
    const emitted: Array<{ threadId: string; chunk: unknown }> = []
    const context = await prepareThreadExecutionContext(
      'project-1',
      'thread-1',
      {
        emit: (threadId, chunk) => {
          emitted.push({ threadId, chunk })
        },
      },
      {
        getProjectRoot: () => '/project',
        getThreadMeta: async () => null,
      },
    )

    assert.equal(context, null)
    assert.equal(emitted.length, 2)
    assert.equal(emitted[0]?.threadId, 'thread-1')
    assert.deepEqual(emitted[1]?.chunk, { type: 'done' })
    assert.match(JSON.stringify(emitted[0].chunk), /does not belong to project/)
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
