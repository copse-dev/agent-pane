import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Project, Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import {
  createThreadCheckoutPreview,
  createThreadCheckoutTransaction,
  type ThreadCheckoutTransactionDependencies,
} from './thread-checkout-transaction.ts'

function blankThread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    title: 'New Thread',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function serial(): ThreadCheckoutTransactionDependencies['serialize'] {
  const chains = new Map<string, Promise<unknown>>()
  return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    chains.set(key, next)
    try {
      return await next
    } finally {
      if (chains.get(key) === next) chains.delete(key)
    }
  }
}

function fixture(overrides: Partial<ThreadCheckoutTransactionDependencies> = {}): {
  prepare: ReturnType<typeof createThreadCheckoutTransaction>
  preview: ReturnType<typeof createThreadCheckoutPreview>
  getThread: () => Thread
  patches: Array<Partial<Omit<Thread, 'messages'>>>
} {
  const project: Project = { id: 'project-1', name: 'Project', path: '/repo' }
  let thread = blankThread()
  const patches: Array<Partial<Omit<Thread, 'messages'>>> = []
  const dependencies: ThreadCheckoutTransactionDependencies = {
    getProject: () => project,
    getThread: async () => thread,
    updateMeta: async (_projectId, _threadId, patch) => {
      patches.push(patch)
      thread = { ...thread, ...patch }
    },
    inspect: async () => ({
      isGitRepository: true,
      currentBranch: 'main',
      defaultBranch: 'main',
      isDirty: false,
      hasSubmodules: false,
    }),
    allocate: async () => {
      throw new Error('unexpected allocation')
    },
    validate: async ({ worktree }) => ({ branch: worktree.branch }),
    retire: async () => undefined,
    serialize: serial(),
    ...overrides,
  }
  return {
    prepare: createThreadCheckoutTransaction(dependencies),
    preview: createThreadCheckoutPreview(dependencies),
    getThread: () => thread,
    patches,
  }
}

describe('first-message checkout transaction', () => {
  it('previews the same authoritative automatic policy used during preparation', async () => {
    const project: Project = {
      id: 'project-1',
      name: 'Project',
      path: '/repo',
      worktreeMode: 'from-default-branch',
    }
    const { preview } = fixture({ getProject: () => project })
    assert.deepEqual(await preview({ projectId: 'project-1', choice: 'automatic' }), {
      checkoutMode: 'worktree',
    })

    const unsupported = fixture({
      getProject: () => project,
      inspect: async () => ({
        isGitRepository: true,
        currentBranch: 'main',
        defaultBranch: 'main',
        isDirty: false,
        hasSubmodules: true,
      }),
    })
    assert.deepEqual(await unsupported.preview({ projectId: 'project-1', choice: 'automatic' }), {
      checkoutMode: 'shared',
    })
  })

  it('persists the default shared decision before returning', async () => {
    const { prepare, getThread, patches } = fixture()
    const result = await prepare({
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'Hello',
      choice: 'automatic',
    })

    assert.deepEqual(result, {
      checkoutMode: 'shared',
      choice: 'automatic',
      branch: 'main',
    })
    assert.equal(patches.length, 1)
    assert.equal(getThread().worktreeChoice, 'automatic')
    assert.equal(getThread().gitBranch, 'main')
  })

  it('allocates exactly once under concurrent isolated preparation and reuses metadata', async () => {
    const worktree: ThreadWorktree = {
      path: '/worktrees/thread-1',
      branch: 'copse/task-thread1',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      createdAt: 2,
      seededFromDirtyProject: false,
    }
    let allocations = 0
    const { prepare } = fixture({
      allocate: async () => {
        allocations += 1
        await Promise.resolve()
        return worktree
      },
    })
    const input = {
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'Build it',
      choice: 'worktree' as const,
    }

    const [first, second] = await Promise.all([prepare(input), prepare(input)])

    assert.equal(allocations, 1)
    assert.equal(first.checkoutMode, 'worktree')
    assert.equal(second.checkoutMode, 'worktree')
    assert.deepEqual(first.worktree, worktree)
    assert.deepEqual(second.worktree, worktree)
  })

  it('does not persist or fall back when explicit isolation is unsupported', async () => {
    const { prepare, patches } = fixture({
      inspect: async () => ({
        isGitRepository: false,
        currentBranch: null,
        defaultBranch: null,
        isDirty: false,
        hasSubmodules: false,
      }),
    })

    await assert.rejects(
      prepare({
        projectId: 'project-1',
        threadId: 'thread-1',
        prompt: 'Try it',
        choice: 'worktree',
      }),
      /not git/,
    )
    assert.equal(patches.length, 0)
  })

  it('keeps legacy conversations on their existing shared checkout', async () => {
    let inspected = false
    const legacy = blankThread({
      gitBranch: 'feature/legacy',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Earlier prompt',
          toolCalls: [],
          createdAt: 1,
        },
      ],
    })
    const { prepare, patches } = fixture({
      getThread: async () => legacy,
      inspect: async () => {
        inspected = true
        throw new Error('should not inspect')
      },
    })

    assert.deepEqual(
      await prepare({
        projectId: 'project-1',
        threadId: 'thread-1',
        prompt: 'Follow up',
        choice: 'worktree',
      }),
      { checkoutMode: 'shared', choice: 'shared', branch: 'feature/legacy' },
    )
    assert.equal(inspected, false)
    assert.equal(patches.length, 0)
  })
})
