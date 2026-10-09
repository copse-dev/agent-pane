import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import {
  createAutomationWorktreeReuse,
  type AutomationWorktreeReuseDependencies,
} from './automation-worktree-reuse.ts'

function worktree(name: string, patch: Partial<ThreadWorktree> = {}): ThreadWorktree {
  return {
    path: `/worktrees/${name}`,
    branch: `copse/${name}`,
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    createdAt: 1,
    seededFromDirtyProject: false,
    ...patch,
  }
}

type ThreadPatch = { [K in keyof Thread]?: Thread[K] | undefined }

function run(id: string, createdAt: number, patch: ThreadPatch = {}): Thread {
  const thread: Thread = {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    automation: { scheduleId: 'schedule-1', scheduleName: 'Nightly', triggeredAt: createdAt },
    worktree: worktree(id),
    createdAt,
    updatedAt: createdAt,
  }
  // An explicit `undefined` means "this thread has no such field", which is how stored threads read.
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(thread, key)
    else Reflect.set(thread, key, value)
  }
  return thread
}

function harness(
  threads: Thread[],
  overrides: Partial<AutomationWorktreeReuseDependencies> = {},
): {
  reuse: ReturnType<typeof createAutomationWorktreeReuse>
  adoptCalls: Array<{ from: string; to: string; baseBranch: string }>
  metaUpdates: Array<{ threadId: string; patch: unknown }>
  disposed: string[]
} {
  const adoptCalls: Array<{ from: string; to: string; baseBranch: string }> = []
  const metaUpdates: Array<{ threadId: string; patch: unknown }> = []
  const disposed: string[] = []
  const reuse = createAutomationWorktreeReuse({
    loadThreads: () => Promise.resolve(threads),
    getThread: (_projectId, threadId) =>
      Promise.resolve(threads.find((thread) => thread.id === threadId) ?? null),
    updateMeta: (_projectId, threadId, patch) => {
      metaUpdates.push({ threadId, patch })
      return Promise.resolve()
    },
    projectRoot: () => '/repo',
    isLive: () => false,
    disposeSession: (threadId) => {
      disposed.push(threadId)
      return Promise.resolve()
    },
    canAdopt: () => Promise.resolve(true),
    adopt: (input) => {
      adoptCalls.push({
        from: input.fromThreadId,
        to: input.toThreadId,
        baseBranch: input.baseBranch,
      })
      return Promise.resolve({
        status: 'adopted',
        worktree: worktree(input.toThreadId, { branch: input.from.branch }),
        previousHead: 'b'.repeat(40),
      })
    },
    now: () => 99,
    ...overrides,
  })
  return { reuse, adoptCalls, metaUpdates, disposed }
}

describe('automation worktree reuse', () => {
  it('hands the most recent finished run’s checkout to the new run and retires the old claim', async () => {
    const threads = [run('older', 1), run('previous', 2), run('next', 3, { worktree: undefined })]
    const { reuse, adoptCalls, metaUpdates, disposed } = harness(threads)
    const result = await reuse.reuseFor({
      projectId: 'p',
      threadId: 'next',
      projectRoot: '/repo',
      baseBranch: 'main',
    })
    assert.equal(result?.branch, 'copse/previous')
    assert.deepEqual(adoptCalls, [{ from: 'previous', to: 'next', baseBranch: 'main' }])
    assert.deepEqual(disposed, ['previous'])
    assert.deepEqual(metaUpdates, [
      {
        threadId: 'previous',
        patch: {
          worktree: { ...worktree('previous'), retiredAt: 99, retiredHead: 'b'.repeat(40) },
        },
      },
    ])
  })

  it('does nothing for an ordinary thread or the first run of a schedule', async () => {
    const ordinary = run('chat', 5, { automation: undefined, worktree: undefined })
    assert.equal(
      await harness([ordinary, run('previous', 2)]).reuse.reuseFor({
        projectId: 'p',
        threadId: 'chat',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
      null,
    )
    const first = harness([run('first', 1, { worktree: undefined })])
    assert.equal(
      await first.reuse.reuseFor({
        projectId: 'p',
        threadId: 'first',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
      null,
    )
    assert.equal(first.adoptCalls.length, 0)
  })

  it('never takes a checkout from a different schedule, a running or unstarted run, or a live one', async () => {
    const next = run('next', 9, { worktree: undefined })
    const input = { projectId: 'p', threadId: 'next', projectRoot: '/repo', baseBranch: 'main' }
    const otherSchedule = run('other', 5, {
      automation: { scheduleId: 'schedule-2', scheduleName: 'Other', triggeredAt: 5 },
    })
    for (const blocker of [
      [otherSchedule],
      [run('busy', 5, { status: 'running' })],
      [run('draft', 5, { draftPrompt: 'not sent yet' })],
    ]) {
      const h = harness([...blocker, next])
      assert.equal(await h.reuse.reuseFor(input), null)
      assert.equal(h.adoptCalls.length, 0)
    }
    const live = harness([run('previous', 5), next], { isLive: () => true })
    assert.equal(await live.reuse.reuseFor(input), null)
    assert.equal(live.adoptCalls.length, 0)
    assert.deepEqual(live.disposed, [])
  })

  it('only considers the newest checkout, so it cannot skip a newer run that is still using its own', async () => {
    const threads = [
      run('older', 1),
      run('newest', 2, { status: 'running' }),
      run('next', 3, { worktree: undefined }),
    ]
    const h = harness(threads)
    assert.equal(
      await h.reuse.reuseFor({
        projectId: 'p',
        threadId: 'next',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
      null,
    )
    assert.equal(h.adoptCalls.length, 0)
  })

  it('leaves the old claim alone when the manager refuses the hand-over', async () => {
    const h = harness([run('previous', 2), run('next', 3, { worktree: undefined })], {
      adopt: () => Promise.resolve({ status: 'ineligible', reason: 'dirty' }),
    })
    assert.equal(
      await h.reuse.reuseFor({
        projectId: 'p',
        threadId: 'next',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
      null,
    )
    assert.deepEqual(h.metaUpdates, [])
  })

  it('retries the old claim’s retirement once, and surfaces a second failure', async () => {
    let attempts = 0
    const flaky = harness([run('previous', 2), run('next', 3, { worktree: undefined })], {
      updateMeta: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('busy')) : Promise.resolve()
      },
    })
    assert.ok(
      await flaky.reuse.reuseFor({
        projectId: 'p',
        threadId: 'next',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
    )
    assert.equal(attempts, 2)
    const broken = harness([run('previous', 2), run('next', 3, { worktree: undefined })], {
      updateMeta: () => Promise.reject(new Error('disk full')),
    })
    await assert.rejects(
      broken.reuse.reuseFor({
        projectId: 'p',
        threadId: 'next',
        projectRoot: '/repo',
        baseBranch: 'main',
      }),
      /disk full/,
    )
  })

  it('reports a checkout as reusable only for the newest finished run, and only if adoptable', async () => {
    const threads = [run('older', 1), run('previous', 2)]
    const { reuse } = harness(threads)
    assert.equal(await reuse.canReusePreviousRun('p', 'previous'), true)
    assert.equal(await reuse.canReusePreviousRun('p', 'older'), false)
    assert.equal(await reuse.canReusePreviousRun('p', 'missing'), false)
    assert.equal(
      await harness(threads, { canAdopt: () => Promise.resolve(false) }).reuse.canReusePreviousRun(
        'p',
        'previous',
      ),
      false,
    )
    assert.equal(
      await harness([run('previous', 2, { status: 'running' })]).reuse.canReusePreviousRun(
        'p',
        'previous',
      ),
      false,
    )
    assert.equal(
      await harness(threads, { projectRoot: () => null }).reuse.canReusePreviousRun(
        'p',
        'previous',
      ),
      false,
    )
  })
})
