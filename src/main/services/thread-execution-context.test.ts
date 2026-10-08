import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getThreadExecutionContext,
  inspectThreadCheckoutRoot,
  prepareThreadExecutionContext,
  requireThreadExecutionContext,
  resolveThreadExecutionContext,
  resolveThreadTerminalExecutionContext,
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
  type ThreadExecutionContextDependencies,
  requireThreadExecutionOwner,
} from './thread-execution-context.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import {
  ThreadWorktreeDetachedError,
  type ValidatedThreadWorktree,
  type ValidatedThreadWorktreeRecovery,
} from './worktree-manager.ts'

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

  it('carries persisted automation metadata as a claim for later corroboration', async () => {
    const automation = {
      scheduleId: 'schedule-1',
      scheduleName: 'Morning review',
      triggeredAt: 42,
    }
    const context = await resolver({
      getThreadMeta: async () => ({ id: 'thread-1', automation }),
    })

    assert.deepEqual(context.automation, automation)
    assert.notEqual(context.automation, automation)
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

  it('keeps every thread surface on the validated checkout during Git recovery', async () => {
    const persisted = {
      path: '/diagnostic/path',
      branch: 'copse/thread-1',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
    }
    const recovery: ValidatedThreadWorktreeRecovery = {
      ...persisted,
      branch: null,
      path: '/validated/root',
      root: '/validated/root',
      gitDir: '/repo/.git/worktrees/thread-1',
      commonGitDir: '/repo/.git',
    }
    let recoveryValidations = 0
    let branchSyncs = 0
    const indexedRoots: string[] = []
    const dependencies: ThreadExecutionContextDependencies = {
      getProjectRoot: () => '/project',
      getThreadMeta: async () => ({ id: 'thread-1', worktree: persisted }),
      validateWorktree: async () => {
        throw new ThreadWorktreeDetachedError(persisted.branch)
      },
      validateWorktreeRecovery: async () => {
        recoveryValidations += 1
        return recovery
      },
      syncWorktreeBranch: async () => {
        branchSyncs += 1
      },
      startWorktreeIndexing: (root) => {
        indexedRoots.push(root)
      },
    }

    const context = await resolveThreadExecutionContext('project-1', 'thread-1', dependencies)

    assert.deepEqual(context, {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      root: '/validated/root',
      checkoutMode: 'worktree',
      branch: null,
    })
    assert.equal(recoveryValidations, 1)
    assert.equal(branchSyncs, 0)
    assert.deepEqual(
      await resolveThreadTerminalExecutionContext('project-1', 'thread-1', dependencies),
      context,
    )
    const prepared = await prepareThreadExecutionContext(
      'project-1',
      'thread-1',
      { emit: () => {} },
      dependencies,
    )
    assert.deepEqual(prepared, context)
    assert.deepEqual(indexedRoots, ['/validated/root'])
  })

  it('still blocks a detached checkout without an active Git recovery', async () => {
    const persisted: ThreadWorktree = {
      path: '/diagnostic/path',
      branch: 'copse/thread-1',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
    }
    const dependencies: ThreadExecutionContextDependencies = {
      getProjectRoot: () => '/project',
      getThreadMeta: async () => ({ id: 'thread-1', worktree: persisted }),
      validateWorktree: async () => {
        throw new ThreadWorktreeDetachedError(persisted.branch)
      },
      validateWorktreeRecovery: async () => {
        throw new ThreadWorktreeDetachedError(persisted.branch)
      },
    }
    await assert.rejects(
      resolveThreadExecutionContext('project-1', 'thread-1', dependencies),
      ThreadWorktreeDetachedError,
    )
  })

  it('does not use terminal recovery for unrelated validation failures', async () => {
    let recoveryValidations = 0
    await assert.rejects(
      resolveThreadTerminalExecutionContext('project-1', 'thread-1', {
        getProjectRoot: () => '/project',
        getThreadMeta: async () => ({
          id: 'thread-1',
          worktree: {
            path: '/missing',
            branch: 'copse/thread-1',
            baseBranch: 'main',
            baseCommit: 'abc123',
            createdAt: 1,
            seededFromDirtyProject: false,
          },
        }),
        validateWorktree: async () => {
          throw new Error('Thread worktree is missing')
        },
        validateWorktreeRecovery: async () => {
          recoveryValidations += 1
          throw new Error('unexpected recovery validation')
        },
      }),
      /Thread worktree is missing/,
    )
    assert.equal(recoveryValidations, 0)
  })

  it('does not index a worktree during generic UI context resolution (#1728)', async () => {
    const validated: ValidatedThreadWorktree = {
      path: '/validated/root',
      branch: 'copse/thread-1',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
      root: '/validated/root',
      gitDir: '/repo/.git/worktrees/thread-1',
      commonGitDir: '/repo/.git',
    }
    const indexedRoots: string[] = []
    await resolver({
      getThreadMeta: async () => ({
        id: 'thread-1',
        worktree: {
          path: '/diagnostic/path',
          branch: 'copse/thread-1',
          baseBranch: 'main',
          baseCommit: 'abc123',
          createdAt: 1,
          seededFromDirtyProject: false,
        },
      }),
      validateWorktree: async () => validated,
      startWorktreeIndexing: (root) => {
        indexedRoots.push(root)
      },
    })

    assert.deepEqual(indexedRoots, [])
  })

  it('never registers a shared checkout with the worktree indexer', async () => {
    const indexedRoots: string[] = []
    await resolver({
      startWorktreeIndexing: (root) => {
        indexedRoots.push(root)
      },
    })

    assert.deepEqual(indexedRoots, [])
  })

  it('prewarms a resolved worktree index when preparing an agent turn (#1400)', async () => {
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
    const indexedRoots: string[] = []

    const context = await prepareThreadExecutionContext(
      'project-1',
      'thread-1',
      { emit: () => {} },
      {
        getProjectRoot: () => '/project',
        getThreadMeta: async () => ({ id: 'thread-1', worktree: persisted }),
        validateWorktree: async () => validated,
        startWorktreeIndexing: (root) => {
          indexedRoots.push(root)
        },
      },
    )

    assert.equal(context?.root, '/validated/root')
    assert.deepEqual(indexedRoots, ['/validated/root'])
  })

  it('coalesces concurrent resolutions for the same persisted thread (#1728)', async () => {
    let releaseMeta: (() => void) | undefined
    const metaCanResolve = new Promise<void>((resolve) => {
      releaseMeta = resolve
    })
    let metaReads = 0
    const dependencies: ThreadExecutionContextDependencies = {
      getProjectRoot: () => '/project',
      getThreadMeta: async () => {
        metaReads += 1
        await metaCanResolve
        return { id: 'thread-1' }
      },
    }

    const first = resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    const second = resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    assert.equal(metaReads, 1)

    releaseMeta?.()
    const [firstContext, secondContext] = await Promise.all([first, second])
    assert.equal(firstContext, secondContext)

    await resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    assert.equal(metaReads, 2)
  })

  it('does not retain a failed resolution for a later request (#1728)', async () => {
    let metaReads = 0
    let shouldFail = true
    const dependencies: ThreadExecutionContextDependencies = {
      getProjectRoot: () => '/project',
      getThreadMeta: async () => {
        metaReads += 1
        if (shouldFail) throw new Error('transient meta read failure')
        return { id: 'thread-1' }
      },
    }

    const first = resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    const second = resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    await assert.rejects(Promise.all([first, second]), /transient meta read failure/)
    assert.equal(metaReads, 1)

    shouldFail = false
    const recovered = await resolveThreadExecutionContext('project-1', 'thread-1', dependencies)
    assert.equal(recovered.root, '/project')
    assert.equal(metaReads, 2)
  })

  it('persists an adopted live branch when Git HEAD drifted inside the worktree', async () => {
    const persisted = {
      path: '/diagnostic/path',
      branch: 'copse/stale',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
    }
    const validated: ValidatedThreadWorktree = {
      ...persisted,
      branch: 'feat/live',
      path: '/validated/root',
      root: '/validated/root',
      gitDir: '/repo/.git/worktrees/thread-1',
      commonGitDir: '/repo/.git',
    }
    let synced: ThreadWorktree | undefined
    const context = await resolver({
      getThreadMeta: async () => ({
        id: 'thread-1',
        gitBranch: 'copse/stale',
        worktree: persisted,
      }),
      validateWorktree: async () => validated,
      syncWorktreeBranch: async (_projectId, _threadId, worktree) => {
        synced = worktree
      },
    })

    assert.equal(context.branch, 'feat/live')
    assert.deepEqual(synced, {
      path: '/diagnostic/path',
      branch: 'feat/live',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1,
      seededFromDirtyProject: false,
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
      /is not persisted yet under project/,
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
    assert.match(JSON.stringify(emitted[0].chunk), /is not persisted yet under project/)
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

describe('thread execution owner', () => {
  it('throws outside any binding, so run-scoped state never lands on a guessed thread', () => {
    assert.throws(() => requireThreadExecutionOwner(), /No thread execution context is active/)
  })

  it('derives the owner from the bound turn context, without exposing its root', () => {
    const result = runWithThreadExecutionContext(
      {
        projectId: 'p1',
        threadId: 't1',
        projectRoot: '/repo',
        root: '/repo',
        checkoutMode: 'shared',
        branch: null,
      },
      () => requireThreadExecutionOwner(),
    )
    assert.deepEqual(result, { projectId: 'p1', threadId: 't1' })
  })
})

describe('inspectThreadCheckoutRoot', () => {
  const worktree = (extra: Partial<ThreadWorktree> = {}): ThreadWorktree => ({
    path: '/worktrees/t1',
    branch: 'copse/t1',
    baseBranch: 'main',
    baseCommit: 'abc',
    createdAt: 1,
    seededFromDirtyProject: false,
    ...extra,
  })
  const inspect = (
    meta: Awaited<ReturnType<ThreadExecutionContextDependencies['getThreadMeta']>>,
  ): Promise<string | null> =>
    inspectThreadCheckoutRoot('project-1', 'thread-1', {
      getProjectRoot: () => '/project',
      getThreadMeta: async () => meta,
      inspectWorktreePath: async (_projectId, _threadId, recorded) =>
        recorded === '/worktrees/t1' ? '/canonical/t1' : null,
    })

  it('returns the project root for a shared thread and the path of an active worktree', async () => {
    assert.equal(await inspect({ id: 'thread-1' }), '/project')
    assert.equal(await inspect({ id: 'thread-1', worktree: worktree() }), '/canonical/t1')
  })

  it('returns null when the recorded worktree path is not the managed one', async () => {
    assert.equal(await inspect({ id: 'thread-1', worktree: worktree({ path: '/etc' }) }), null)
  })

  it('returns null for retired or PR worktrees instead of restoring them', async () => {
    assert.equal(await inspect({ id: 'thread-1', worktree: worktree({ retiredAt: 5 }) }), null)
    assert.equal(
      await inspect({
        id: 'thread-1',
        worktree: worktree({ pullRequestUrl: 'https://github.com/o/r/pull/1' }),
      }),
      null,
    )
  })

  it('returns null for an unknown project or thread, or a mismatched id', async () => {
    assert.equal(await inspect(null), null)
    assert.equal(await inspect({ id: 'other' }), null)
    assert.equal(
      await inspectThreadCheckoutRoot('project-1', 'thread-1', {
        getProjectRoot: () => null,
        getThreadMeta: async () => ({ id: 'thread-1' }),
      }),
      null,
    )
  })
})
