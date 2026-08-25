import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import { allocateThreadWorktree, readThreadWorktreeRecoveryMetadata } from './worktree-manager.ts'
import {
  createThreadCheckoutPreview,
  createThreadCheckoutTransaction,
  recoverUnpersistedWorktree,
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
    recoverUnpersisted: async () => null,
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
    const { preview } = fixture()
    assert.deepEqual(await preview({ projectId: 'project-1', choice: 'automatic' }), {
      checkoutMode: 'worktree',
    })

    const unsupported = fixture({
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

    const optedOut: Project = {
      id: 'project-1',
      name: 'Project',
      path: '/repo',
      worktreeMode: 'never',
    }
    const shared = fixture({ getProject: () => optedOut })
    assert.deepEqual(await shared.preview({ projectId: 'project-1', choice: 'automatic' }), {
      checkoutMode: 'shared',
    })
  })

  it('persists the shared decision of an opted-out project before returning', async () => {
    const optedOut: Project = {
      id: 'project-1',
      name: 'Project',
      path: '/repo',
      worktreeMode: 'never',
    }
    const { prepare, getThread, patches } = fixture({ getProject: () => optedOut })
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

  it('bases an automatic worktree on the branch selected in the blank-thread picker', async () => {
    const allocations: Array<{ baseBranch: string; seedFromDirtyProject: boolean }> = []
    const { prepare } = fixture({
      // The picker changes the live checkout, so this is the branch the user
      // sees selected when they send the first message.
      inspect: async () => ({
        isGitRepository: true,
        currentBranch: 'copse/previous-thread',
        defaultBranch: 'main',
        isDirty: true,
        hasSubmodules: false,
      }),
      allocate: async ({ baseBranch, seedFromDirtyProject }) => {
        allocations.push({ baseBranch, seedFromDirtyProject })
        return {
          path: '/worktrees/thread-1',
          branch: 'copse/fresh-thread1',
          baseBranch,
          baseCommit: 'e'.repeat(40),
          createdAt: 5,
          seededFromDirtyProject: false,
        }
      },
    })

    const result = await prepare({
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'Something unrelated',
      choice: 'automatic',
    })

    assert.equal(result.checkoutMode, 'worktree')
    assert.deepEqual(allocations, [
      { baseBranch: 'copse/previous-thread', seedFromDirtyProject: true },
    ])
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

  it('adopts and persists a live worktree branch that drifted from meta', async () => {
    const stale: ThreadWorktree = {
      path: '/worktrees/thread-1',
      branch: 'copse/stale',
      baseBranch: 'main',
      baseCommit: 'd'.repeat(40),
      createdAt: 3,
      seededFromDirtyProject: false,
    }
    const { prepare, getThread, patches } = fixture({
      getThread: async () =>
        blankThread({
          worktreeChoice: 'worktree',
          gitBranch: 'copse/stale',
          worktree: stale,
        }),
      validate: async () => ({ branch: 'feat/live' }),
    })

    const result = await prepare({
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'Continue after rename',
      choice: 'worktree',
    })

    assert.equal(result.checkoutMode, 'worktree')
    assert.equal(result.branch, 'feat/live')
    assert.equal(result.worktree?.branch, 'feat/live')
    assert.equal(getThread().gitBranch, 'feat/live')
    assert.equal(getThread().worktree?.branch, 'feat/live')
    assert.equal(patches.length, 1)
    assert.equal(patches[0]?.gitBranch, 'feat/live')
  })

  it('reclaims the original allocation metadata after the project branch changed', async () => {
    const recovered: ThreadWorktree = {
      path: '/worktrees/thread-1',
      branch: 'copse/task-thread1',
      baseBranch: 'main',
      baseCommit: 'b'.repeat(40),
      createdAt: 3,
      seededFromDirtyProject: true,
    }
    let allocations = 0
    let retireCalls = 0
    const { prepare, getThread } = fixture({
      inspect: async () => ({
        isGitRepository: true,
        currentBranch: 'feature/switched-after-failure',
        defaultBranch: 'main',
        isDirty: true,
        hasSubmodules: false,
      }),
      allocate: async () => {
        allocations += 1
        throw new Error('Thread worktree is already registered: /worktrees/thread-1')
      },
      recoverUnpersisted: async () => recovered,
      retire: async () => {
        retireCalls += 1
        return { status: 'blocked-dirty', paths: ['scratch.txt'] }
      },
    })

    const result = await prepare({
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'Retry after meta failure',
      choice: 'worktree',
    })

    assert.equal(allocations, 0)
    assert.equal(retireCalls, 0)
    assert.equal(result.checkoutMode, 'worktree')
    assert.deepEqual(result.worktree, recovered)
    assert.equal(result.worktree.baseBranch, 'main')
    assert.equal(result.worktree.baseCommit, 'b'.repeat(40))
    assert.equal(getThread().worktreeChoice, 'worktree')
    assert.equal(getThread().gitBranch, recovered.branch)
    assert.deepEqual(getThread().worktree, recovered)
  })

  it('retains a dirty-seeded worktree when metadata persistence fails', async () => {
    const worktree: ThreadWorktree = {
      path: '/worktrees/thread-1',
      branch: 'copse/task-thread1',
      baseBranch: 'main',
      baseCommit: 'c'.repeat(40),
      createdAt: 4,
      seededFromDirtyProject: true,
    }
    let retireCalls = 0
    const { prepare } = fixture({
      allocate: async () => worktree,
      updateMeta: async () => {
        throw new Error('disk full')
      },
      retire: async () => {
        retireCalls += 1
        return { status: 'blocked-dirty', paths: ['scratch.txt'] }
      },
    })

    await assert.rejects(
      prepare({
        projectId: 'project-1',
        threadId: 'thread-1',
        prompt: 'Persist please',
        choice: 'worktree',
      }),
      /disk full/,
    )
    assert.equal(retireCalls, 0, 'dirty-seeded checkouts must stay registered for reclaim')
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

describe('reclaiming a linked checkout with no recovery marker', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Copse Test',
        GIT_AUTHOR_EMAIL: 'copse@example.invalid',
        GIT_COMMITTER_NAME: 'Copse Test',
        GIT_COMMITTER_EMAIL: 'copse@example.invalid',
      },
    })
  }

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousRoot
    previousRoot = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('reclaims a checkout whose marker is missing instead of stranding the thread', async () => {
    // A worktree cut before the marker existed — or by a run that died between
    // `worktree add` and the config write — is still registered with Git. If the
    // reclaim refuses it, the caller allocates again, that allocation throws
    // "already registered", and the thread never starts. Automation runs hit
    // this first because their fixtures outlive a single run.
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-reclaim-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)

    const repo = join(temp, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])

    const allocated = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      prompt: 'Scheduled review',
      baseBranch: 'main',
      seedFromDirtyProject: false,
    })
    // Strip the marker to reproduce a checkout that predates it.
    git(repo, [
      'config',
      '--local',
      '--unset',
      `branch.${allocated.branch}.copse-worktree-recovery`,
    ])
    assert.equal(await readThreadWorktreeRecoveryMetadata(repo, allocated.branch), null)

    const recovered = await recoverUnpersistedWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      baseBranch: 'main',
    })

    assert.ok(recovered, 'a registered checkout must still be reclaimable without its marker')
    assert.equal(recovered.path, allocated.path)
    assert.equal(recovered.branch, allocated.branch)
    assert.equal(recovered.baseBranch, 'main')
    assert.equal(recovered.baseCommit, git(repo, ['rev-parse', 'HEAD']).trim())
    // Conservative: this process never saw the checkout created, so retirement
    // must keep refusing to discard whatever it holds.
    assert.equal(recovered.seededFromDirtyProject, true)
  })

  it('still declines when no checkout is registered for the thread', async () => {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-reclaim-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)

    const repo = join(temp, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])

    assert.equal(
      await recoverUnpersistedWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        baseBranch: 'main',
      }),
      null,
    )
  })
})
