import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Thread } from '@shared/types'
import type { PreparedThreadCheckout, ThreadWorktree } from '@shared/types/worktree.ts'
import { toolNeedsWritableCheckout } from '@shared/tools/deferred-checkout-tools.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest, resolvePathWithinRoot } from './workspace.ts'
import { allocateThreadWorktree } from './worktree-manager.ts'
import {
  createDeferredWorktreeAllocation,
  createThreadCheckoutTransaction,
  inspectProject,
  type ThreadCheckoutTransactionDependencies,
} from './thread-checkout-transaction.ts'
import {
  adoptUpgradedThreadExecutionContext,
  getThreadExecutionContext,
  isThreadCheckoutDeferred,
  releaseUpgradedThreadExecutionContext,
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import {
  createEnsureWritableThreadCheckout,
  describeWriteAccessGrant,
  type DeferredWorktreeDependencies,
} from './deferred-worktree.ts'

const ON_WRITE: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/repo',
  worktreeMode: 'on-write',
}
const NATIVE_MODEL = 'anthropic:claude-sonnet-5'

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

const WORKTREE: ThreadWorktree = {
  path: '/worktrees/project-1/thread-1',
  branch: 'copse/fix-login-redirect-hread1',
  baseBranch: 'main',
  baseCommit: 'b'.repeat(40),
  createdAt: 2,
  seededFromDirtyProject: false,
}

function fixture(
  overrides: Partial<ThreadCheckoutTransactionDependencies> = {},
  initial: Thread = blankThread(),
): {
  dependencies: ThreadCheckoutTransactionDependencies
  getThread: () => Thread
  allocations: Array<Parameters<ThreadCheckoutTransactionDependencies['allocate']>[0]>
  checkouts: string[]
} {
  let thread = initial
  const allocations: Array<Parameters<ThreadCheckoutTransactionDependencies['allocate']>[0]> = []
  const checkouts: string[] = []
  const dependencies: ThreadCheckoutTransactionDependencies = {
    getProject: () => ON_WRITE,
    getThread: async () => thread,
    updateMeta: async (_projectId, _threadId, patch) => {
      thread = { ...thread, ...patch }
    },
    inspect: async () => ({
      isGitRepository: true,
      currentBranch: 'main',
      defaultBranch: 'main',
      isDirty: false,
      hasSubmodules: false,
    }),
    allocate: async (input) => {
      allocations.push(input)
      return WORKTREE
    },
    recoverUnpersisted: async () => null,
    branchExists: async () => true,
    checkoutBranch: async (branch) => {
      checkouts.push(branch)
    },
    validate: async ({ worktree }) => ({ branch: worktree.branch }),
    retire: async () => undefined,
    serialize: async (_key, task) => task(),
    ...overrides,
  }
  return { dependencies, getThread: () => thread, allocations, checkouts }
}

describe('first message in an on-write project', () => {
  it('records the deferral instead of allocating, and leaves the checkout alone', async () => {
    const { dependencies, getThread, allocations, checkouts } = fixture()
    const prepared = await createThreadCheckoutTransaction(dependencies)({
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'why does login redirect twice?',
      choice: 'automatic',
      model: NATIVE_MODEL,
      baseBranch: 'feature',
    })
    assert.equal(allocations.length, 0)
    // The picked branch is the future base, not a reason to move the user's HEAD.
    assert.deepEqual(checkouts, [])
    assert.equal(prepared.checkoutMode, 'shared')
    assert.equal(prepared.worktree, undefined)
    assert.equal(prepared.deferredWorktree?.baseBranch, 'feature')
    assert.equal(getThread().deferredWorktree?.baseBranch, 'feature')
    assert.equal(getThread().worktreeChoice, 'automatic')
  })

  it('returns the same deferral when the first send is retried', async () => {
    const { dependencies } = fixture()
    const prepare = createThreadCheckoutTransaction(dependencies)
    const input = {
      projectId: 'project-1',
      threadId: 'thread-1',
      prompt: 'explain this',
      choice: 'automatic' as const,
      model: NATIVE_MODEL,
    }
    const first = await prepare(input)
    const second = await prepare(input)
    assert.deepEqual(second.deferredWorktree, first.deferredWorktree)
  })

  it('allocates up front for an ACP agent, an unknown model, or an explicit worktree choice', async () => {
    const cases = [
      { choice: 'automatic' as const, model: 'acp:claude-code' },
      { choice: 'automatic' as const, model: undefined },
      { choice: 'worktree' as const, model: NATIVE_MODEL },
    ]
    for (const { choice, model } of cases) {
      const { dependencies, allocations, getThread } = fixture()
      const prepared = await createThreadCheckoutTransaction(dependencies)({
        projectId: 'project-1',
        threadId: 'thread-1',
        prompt: 'fix it',
        choice,
        ...(model !== undefined ? { model } : {}),
      })
      assert.equal(allocations.length, 1, `${choice} / ${String(model)}`)
      assert.equal(prepared.checkoutMode, 'worktree')
      assert.equal(getThread().deferredWorktree, undefined)
    }
  })
})

describe('deferred worktree allocation', () => {
  const deferredThread = blankThread({
    worktreeChoice: 'automatic',
    deferredWorktree: { baseBranch: 'main', requestedAt: 1 },
  })

  it('allocates from the recorded base, names the branch, and seeds the live dirty work', async () => {
    const { dependencies, allocations, getThread } = fixture(
      {
        inspect: async () => ({
          isGitRepository: true,
          currentBranch: 'main',
          defaultBranch: 'main',
          isDirty: true,
          hasSubmodules: false,
        }),
      },
      deferredThread,
    )
    const prepared = await createDeferredWorktreeAllocation(dependencies)({
      projectId: 'project-1',
      threadId: 'thread-1',
      branchTitle: 'fix login redirect',
    })
    assert.equal(allocations.length, 1)
    const [allocation] = allocations
    assert.ok(allocation)
    assert.equal(allocation.baseBranch, 'main')
    assert.equal(allocation.branchTitle, 'fix login redirect')
    assert.equal(allocation.seedFromDirtyProject, true)
    assert.equal(prepared.checkoutMode, 'worktree')
    assert.ok(prepared.deferredWorktree, 'the allocating call reports the deferral it resolved')
    assert.equal(getThread().worktree?.branch, WORKTREE.branch)
    assert.equal(getThread().gitBranch, WORKTREE.branch)
  })

  it('is idempotent: a second call returns the worktree without allocating again', async () => {
    const { dependencies, allocations } = fixture({}, deferredThread)
    const allocate = createDeferredWorktreeAllocation(dependencies)
    await allocate({ projectId: 'project-1', threadId: 'thread-1' })
    const again = await allocate({ projectId: 'project-1', threadId: 'thread-1' })
    assert.equal(allocations.length, 1)
    assert.equal(again.worktree?.branch, WORKTREE.branch)
    assert.equal(again.deferredWorktree, undefined, 'only the allocating call reports it')
  })

  it('refuses a thread that never deferred', async () => {
    const { dependencies } = fixture({}, blankThread({ worktreeChoice: 'shared' }))
    await assert.rejects(
      createDeferredWorktreeAllocation(dependencies)({
        projectId: 'project-1',
        threadId: 'thread-1',
      }),
      /did not defer/,
    )
  })
})

describe('execution context of a deferred turn', () => {
  const projectRoot = '/repo'
  const deferred = { baseBranch: 'main', requestedAt: 1 }

  function resolveDeferred(): Promise<ThreadExecutionContext> {
    return resolveThreadExecutionContext('project-1', 'thread-1', {
      getProjectRoot: () => projectRoot,
      getThreadMeta: async () => ({
        id: 'thread-1',
        gitBranch: 'main',
        deferredWorktree: deferred,
      }),
    })
  }

  const worktreeContext: ThreadExecutionContext = {
    projectId: 'project-1',
    threadId: 'thread-1',
    projectRoot,
    root: '/worktrees/project-1/thread-1',
    checkoutMode: 'worktree',
    branch: WORKTREE.branch,
  }

  afterEach(() => {
    releaseUpgradedThreadExecutionContext({ projectId: 'project-1', threadId: 'thread-1' })
  })

  it('is a shared-rooted read-only view until the thread owns a worktree', async () => {
    const context = await resolveDeferred()
    assert.equal(context.root, projectRoot)
    assert.equal(context.checkoutMode, 'shared')
    assert.deepEqual(context.deferredWorktree, deferred)
    runWithThreadExecutionContext(context, () => {
      assert.equal(isThreadCheckoutDeferred(), true)
    })
  })

  it('moves every bound copy of the turn onto the worktree at once, until released', async () => {
    const context = await resolveDeferred()
    await runWithThreadExecutionContext(context, async () => {
      adoptUpgradedThreadExecutionContext(worktreeContext)
      assert.equal(getThreadExecutionContext()?.root, worktreeContext.root)
      assert.equal(isThreadCheckoutDeferred(), false)
      // A subagent or bridge that re-bound its own copy of the deferred context
      // follows the same upgrade rather than keeping the user's checkout.
      await runWithThreadExecutionContext(context, async () => {
        assert.equal(getThreadExecutionContext()?.root, worktreeContext.root)
      })
    })
    releaseUpgradedThreadExecutionContext(context)
    runWithThreadExecutionContext(context, () => {
      assert.equal(getThreadExecutionContext()?.root, projectRoot)
    })
  })

  it('never lets an upgrade redirect a thread that is not deferred', () => {
    const shared: ThreadExecutionContext = {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot,
      root: projectRoot,
      checkoutMode: 'shared',
      branch: 'main',
    }
    adoptUpgradedThreadExecutionContext(worktreeContext)
    runWithThreadExecutionContext(shared, () => {
      assert.equal(getThreadExecutionContext()?.root, projectRoot)
    })
    assert.throws(() => {
      adoptUpgradedThreadExecutionContext(shared)
    }, /must own a worktree/)
  })
})

describe('ensureWritableThreadCheckout', () => {
  const deferredContext: ThreadExecutionContext = {
    projectId: 'project-1',
    threadId: 'thread-1',
    projectRoot: '/repo',
    root: '/repo',
    checkoutMode: 'shared',
    branch: 'main',
    deferredWorktree: { baseBranch: 'main', requestedAt: 1 },
  }
  const upgraded: ThreadExecutionContext = {
    projectId: 'project-1',
    threadId: 'thread-1',
    projectRoot: '/repo',
    root: WORKTREE.path,
    checkoutMode: 'worktree',
    branch: WORKTREE.branch,
  }

  afterEach(() => {
    releaseUpgradedThreadExecutionContext(deferredContext)
  })

  function dependencies(
    patch: Partial<DeferredWorktreeDependencies> = {},
  ): DeferredWorktreeDependencies & { adopted: ThreadExecutionContext[]; indexed: string[] } {
    const adopted: ThreadExecutionContext[] = []
    const indexed: string[] = []
    const prepared: PreparedThreadCheckout = {
      checkoutMode: 'worktree',
      choice: 'automatic',
      branch: WORKTREE.branch,
      worktree: WORKTREE,
      deferredWorktree: { baseBranch: 'main', requestedAt: 1 },
    }
    return {
      adopted,
      indexed,
      allocate: async () => prepared,
      resolve: async () => upgraded,
      adopt: (context): void => {
        adopted.push(context)
        adoptUpgradedThreadExecutionContext(context)
      },
      startIndexing: (root): void => {
        indexed.push(root)
      },
      readProjectState: async () => ({ head: 'a'.repeat(40), dirtyPaths: ['src/wip.ts'] }),
      changedPaths: async () => ['src/login.ts'],
      ...patch,
    }
  }

  it('does nothing for a thread that can already write', async () => {
    const deps = dependencies({
      allocate: async () => {
        throw new Error('must not allocate')
      },
    })
    const grant = await runWithThreadExecutionContext(upgraded, () =>
      createEnsureWritableThreadCheckout(deps)(),
    )
    assert.equal(grant?.allocation, undefined)
    assert.equal(grant?.context.root, WORKTREE.path)
  })

  it('allocates, re-roots the turn, indexes the new root, and explains the switch', async () => {
    const deps = dependencies()
    const grant = await runWithThreadExecutionContext(deferredContext, async () => {
      const result = await createEnsureWritableThreadCheckout(deps)({ branchTitle: 'fix login' })
      assert.equal(getThreadExecutionContext()?.root, WORKTREE.path)
      return result
    })
    assert.ok(grant?.allocation)
    assert.deepEqual(deps.indexed, [WORKTREE.path])
    assert.deepEqual(grant.allocation.changedSinceRead, ['src/login.ts'])

    const text = describeWriteAccessGrant(grant)
    assert.match(text, new RegExp(WORKTREE.path))
    assert.match(text, new RegExp(WORKTREE.branch))
    assert.match(text, /Re-read these before editing them:\n {2}- src\/login\.ts/)
    // Unseeded dirty work the agent could see is named, so it does not assume
    // the user's uncommitted edits came with it.
    assert.match(text, /were NOT copied into the worktree[\s\S]*src\/wip\.ts/)
  })

  it('says nothing about drift when the agent read exactly the base', async () => {
    const deps = dependencies({
      readProjectState: async () => ({ head: WORKTREE.baseCommit, dirtyPaths: [] }),
      changedPaths: async () => {
        throw new Error('no diff needed when the commits match')
      },
    })
    const grant = await runWithThreadExecutionContext(deferredContext, () =>
      createEnsureWritableThreadCheckout(deps)(),
    )
    assert.ok(grant)
    assert.doesNotMatch(describeWriteAccessGrant(grant), /Re-read|uncommitted/)
  })
})

describe('toolNeedsWritableCheckout', () => {
  const contained = { sandboxEnabled: true, runsOutsideSandbox: false, expectsSandboxBlock: false }

  it('keeps reads, inspection, and network reads on the checkout', () => {
    for (const toolName of [
      'read_file',
      'search_code',
      'git_log',
      'explore',
      'fetch_url',
      'gh_pr_view',
    ]) {
      assert.equal(toolNeedsWritableCheckout({ toolName }), false, toolName)
    }
    assert.equal(toolNeedsWritableCheckout({ toolName: 'request_write_access' }), false)
  })

  it('allocates first for anything that may write, including tools it does not know', () => {
    for (const toolName of [
      'write_file',
      'str_replace',
      'git_commit',
      'prepare_worktree',
      'gh_pr_create',
      'run_background',
      'some_future_tool',
    ]) {
      assert.equal(toolNeedsWritableCheckout({ toolName }), true, toolName)
    }
  })

  it('keeps run_shell deferred only while it will run contained', () => {
    assert.equal(toolNeedsWritableCheckout({ toolName: 'run_shell', shell: contained }), false)
    for (const shell of [
      { ...contained, sandboxEnabled: false },
      { ...contained, runsOutsideSandbox: true },
      { ...contained, expectsSandboxBlock: true },
    ]) {
      assert.equal(toolNeedsWritableCheckout({ toolName: 'run_shell', shell }), true)
    }
    assert.equal(toolNeedsWritableCheckout({ toolName: 'run_shell' }), true, 'unknown routing')
  })

  it('trusts only read-only, non-destructive MCP annotations', () => {
    const name = 'mcp__server__tool'
    assert.equal(
      toolNeedsWritableCheckout({ toolName: name, mcpAnnotations: { readOnlyHint: true } }),
      false,
    )
    assert.equal(toolNeedsWritableCheckout({ toolName: name }), true)
  })
})

describe('deferred allocation against a real repository', () => {
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

  it('names the branch from the agent and carries the dirty work it read', async () => {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-deferred-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)

    const repo = join(temp, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    await writeFile(join(repo, 'README.md'), 'user edit\n')

    const project: Project = { ...ON_WRITE, path: repo }
    const { dependencies } = fixture(
      { getProject: () => project, inspect: inspectProject, allocate: allocateThreadWorktree },
      blankThread({
        worktreeChoice: 'automatic',
        deferredWorktree: { baseBranch: 'main', requestedAt: 1 },
      }),
    )
    const prepared = await createDeferredWorktreeAllocation(dependencies)({
      projectId: 'project-1',
      threadId: 'thread-1',
      branchTitle: 'Fix login redirect',
    })
    const worktree = prepared.worktree
    assert.ok(worktree)
    assert.match(worktree.branch, /^copse\/fix-login-redirect-/)
    assert.equal(worktree.seededFromDirtyProject, true)
    assert.equal(await readFile(join(worktree.path, 'README.md'), 'utf-8'), 'user edit\n')
    // The user's checkout is exactly as it was: same branch, same dirty file.
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
    assert.equal(git(repo, ['status', '--porcelain']).trim(), 'M README.md')
  })
})

describe('absolute project paths in a worktree turn', () => {
  it('resolve to the same file in the worktree for file tools, and nowhere else', async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-path-alias-')))
    try {
      const projectRoot = join(temp, 'project')
      const worktreeRoot = join(temp, 'worktree')
      await mkdir(join(projectRoot, 'src'), { recursive: true })
      await mkdir(join(worktreeRoot, 'src'), { recursive: true })
      await mkdir(join(temp, 'other'), { recursive: true })
      const context: ThreadExecutionContext = {
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot,
        root: worktreeRoot,
        checkoutMode: 'worktree',
        branch: 'copse/x',
      }
      const projectFile = join(projectRoot, 'src', 'login.ts')

      await runWithThreadExecutionContext(context, async () => {
        assert.equal(
          await resolvePathWithinRoot(projectFile, worktreeRoot),
          join(worktreeRoot, 'src', 'login.ts'),
        )
        // A path outside both checkouts is still refused.
        await assert.rejects(
          resolvePathWithinRoot(join(temp, 'elsewhere.ts'), worktreeRoot),
          /outside workspace/,
        )
        // Only the turn's own root is aliased; an explicit other root is not.
        await assert.rejects(
          resolvePathWithinRoot(projectFile, join(temp, 'other')),
          /outside workspace/,
        )
      })
      // Outside a turn, and in a shared turn, nothing is rebased.
      await assert.rejects(resolvePathWithinRoot(projectFile, worktreeRoot), /outside workspace/)
      await runWithThreadExecutionContext(
        { ...context, root: projectRoot, checkoutMode: 'shared' },
        async () => {
          await assert.rejects(
            resolvePathWithinRoot(projectFile, worktreeRoot),
            /outside workspace/,
          )
        },
      )
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
