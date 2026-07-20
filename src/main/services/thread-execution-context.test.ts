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
import type { ValidatedThreadWorktree } from './worktree-manager.ts'

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
    validateWorktree: async () => {
      throw new Error('unexpected worktree validation')
    },
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

  it('retains the persisted shared branch without deriving it from active HEAD', async () => {
    const context = await resolver({
      getThreadMeta: async () => ({ id: 'thread-1', gitBranch: 'feature/shared' }),
    })

    assert.equal(context.checkoutMode, 'shared')
    assert.equal(context.branch, 'feature/shared')
  })

  it('uses only a manager-validated worktree root and branch', async () => {
    const persisted = {
      path: '/diagnostic/path',
      branch: 'copse/thread-1',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
    }
    const validated: ValidatedThreadWorktree = {
      ...persisted,
      path: '/validated/root',
      root: '/validated/root',
      gitDir: '/repo/.git/worktrees/thread-1',
      commonGitDir: '/repo/.git',
    }
    let received: unknown
    const context = await resolver({
      getThreadMeta: async () => ({ id: 'thread-1', worktree: persisted }),
      validateWorktree: async (input) => {
        received = input
        return validated
      },
    })

    assert.deepEqual(received, {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      worktree: persisted,
    })
    assert.deepEqual(context, {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      root: '/validated/root',
      checkoutMode: 'worktree',
      branch: 'copse/thread-1',
    })
  })

  it('does not fall back to the project checkout when worktree validation fails', async () => {
    await assert.rejects(
      resolver({
        getThreadMeta: async () => ({
          id: 'thread-1',
          worktree: {
            path: '/missing',
            branch: 'copse/missing',
            baseBranch: 'main',
            baseCommit: 'abc123',
            createdAt: 1,
            seededFromDirtyProject: false,
          },
        }),
        validateWorktree: async () => {
          throw new Error('Thread worktree is missing')
        },
      }),
      /Thread worktree is missing/,
    )
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
