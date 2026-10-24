import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from '../workspace.ts'
import type { Thread } from '@shared/types'
import { stageDiff, getStagedDiffEntry, clearDiffQueueForTest } from '../diff-queue.ts'
import {
  getThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import { writeFileTool } from '../../tools/write-file-tool.ts'
import {
  allocateThreadWorktree,
  validateThreadWorktree,
  retireThreadWorktree,
  WorktreeAllocationError,
} from '../worktree-manager.ts'
import {
  runInIsolatedWorkerCheckout,
  type WorkerCheckout,
  type WorkerCheckoutDependencies,
} from './isolated-worker-checkout.ts'

const previousRoot = process.env['COPSE_WORKTREES_DIR']
const roots: string[] = []
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  })
}
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error('uninitialized')
  }
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function setup(): Promise<{
  parent: ThreadExecutionContext
  dependencies: WorkerCheckoutDependencies
  saved: Map<string, Thread>
}> {
  const temp = await mkdtemp(join(tmpdir(), 'copse-writable-worker-'))
  roots.push(temp)
  process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
  setGitAvailableForTest(true)
  const root = join(temp, 'repo')
  await mkdir(root)
  git(root, ['init', '-q', '-b', 'main'])
  await writeFile(join(root, 'same.txt'), 'parent')
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'initial'])
  const saved = new Map<string, Thread>()
  const dependencies: WorkerCheckoutDependencies = {
    allocate: allocateThreadWorktree,
    validate: validateThreadWorktree,
    retire: retireThreadWorktree,
    detachedHooksEnabled: () => false,
    withDispatchSlot: (_owner, execute) => execute(),
    branch: async () => 'main',
    save: async (_projectId, thread) => {
      saved.set(thread.id, thread)
    },
    update: async (_projectId, id, patch) => {
      assert.ok(saved.has(id))
      const previous = saved.get(id)
      assert.ok(previous)
      saved.set(id, { ...previous, ...patch })
    },
    append: async () => undefined,
  }
  return {
    parent: {
      projectId: 'project',
      threadId: 'parent',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: 'main',
    },
    dependencies,
    saved,
  }
}
afterEach(async () => {
  if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
  else process.env['COPSE_WORKTREES_DIR'] = previousRoot
  setGitAvailableForTest(null)
  clearAllowedWorkspaceRootsForTest()
  clearDiffQueueForTest()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('separates concurrent same-path writes and rejects absolute, traversal and symlink sibling writes', async () => {
  const { parent, dependencies, saved } = await setup()
  const checkouts = new Map<string, WorkerCheckout>()
  const started = latch()
  const run = (workerId: string): Promise<string> =>
    runInIsolatedWorkerCheckout(
      {
        parent,
        workerId,
        request: { agent: workerId, prompt: 'Edit same.txt' },
        signal: new AbortController().signal,
        onCheckout: (checkout) => {
          checkouts.set(workerId, checkout)
        },
        execute: async () => {
          if (checkouts.size === 2) started.resolve()
          await started.promise
          assert.equal(getThreadExecutionContext()?.threadId, workerId)
          const own = checkouts.get(workerId)
          const sibling = checkouts.get(workerId === 'alpha' ? 'beta' : 'alpha')
          assert.ok(own && sibling)
          await writeFileTool.execute(
            { path: join(parent.root, 'same.txt'), content: workerId },
            new AbortController().signal,
          )
          for (const path of [join(sibling.path, 'same.txt'), `../${sibling.threadId}/same.txt`]) {
            await assert.rejects(async () =>
              writeFileTool.execute({ path, content: 'clobber' }, new AbortController().signal),
            )
          }
          await symlink(sibling.path, join(own.path, 'escape'))
          await assert.rejects(async () =>
            writeFileTool.execute(
              { path: 'escape/same.txt', content: 'clobber' },
              new AbortController().signal,
            ),
          )
          await stageDiff('pending.txt', '', workerId, 'plaintext')
          return workerId
        },
      },
      dependencies,
    )
  assert.deepEqual(await Promise.all([run('alpha'), run('beta')]), ['alpha', 'beta'])
  for (const [id, checkout] of checkouts) {
    assert.equal(await readFile(join(checkout.path, 'same.txt'), 'utf8'), id)
    assert.equal(checkout.cleanup, 'retained')
    assert.ok(saved.has(id))
    assert.equal(
      getStagedDiffEntry('pending.txt', { projectId: parent.projectId, threadId: id })?.after,
      id,
    )
  }
  assert.equal(await readFile(join(parent.root, 'same.txt'), 'utf8'), 'parent')
})

it('cancellation during allocation persists ownership, never starts inference and retires the clean checkout', async () => {
  const { parent, dependencies, saved } = await setup()
  const controller = new AbortController()
  let checkout: WorkerCheckout | undefined
  let calls = 0
  await assert.rejects(
    runInIsolatedWorkerCheckout(
      {
        parent,
        workerId: 'allocation',
        request: { agent: 'alpha', prompt: 'edit' },
        signal: controller.signal,
        onCheckout: (value) => {
          checkout = value
        },
        execute: async () => {
          calls++
          return 'unexpected'
        },
      },
      {
        ...dependencies,
        allocate: async (input) => {
          const result = await dependencies.allocate(input)
          controller.abort()
          return result
        },
      },
    ),
  )
  assert.equal(calls, 0)
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'removed')
  assert.ok(saved.has('allocation'))
  await assert.rejects(access(checkout.path))
})

it('keeps a cancelled checkout alive until the late writer settles, then preserves its ignored edits', async () => {
  const { parent, dependencies } = await setup()
  const controller = new AbortController()
  const started = latch()
  const release = latch()
  let checkout: WorkerCheckout | undefined
  const run = runInIsolatedWorkerCheckout(
    {
      parent,
      workerId: 'late',
      request: { agent: 'alpha', prompt: 'edit' },
      signal: controller.signal,
      onCheckout: (value) => {
        checkout = value
      },
      execute: async () => {
        started.resolve()
        await release.promise
        assert.ok(checkout)
        await writeFile(join(checkout.path, 'ignored.txt'), 'late work')
        return 'must not succeed'
      },
    },
    dependencies,
  )
  await started.promise
  controller.abort()
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'pending')
  await access(checkout.path)
  release.resolve()
  await assert.rejects(run)
  assert.equal(checkout.cleanup, 'retained')
  assert.equal(await readFile(join(checkout.path, 'ignored.txt'), 'utf8'), 'late work')
})

it('retains work when cleanup inspection fails and reports the recovery error', async () => {
  const { parent, dependencies } = await setup()
  let checkout: WorkerCheckout | undefined
  await runInIsolatedWorkerCheckout(
    {
      parent,
      workerId: 'inspection',
      request: { agent: 'alpha', prompt: 'edit' },
      signal: new AbortController().signal,
      onCheckout: (value) => {
        checkout = value
      },
      execute: async () => 'report',
    },
    {
      ...dependencies,
      retire: async () => {
        throw new Error('cannot inspect')
      },
    },
  )
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'retained')
  assert.match(checkout.error ?? '', /cannot inspect/)
  await access(checkout.path)
})

it('preserves allocation recovery snapshots even when the partial checkout appears clean', async () => {
  const { parent, dependencies } = await setup()
  let checkout: WorkerCheckout | undefined
  const notes: string[] = []
  await assert.rejects(
    runInIsolatedWorkerCheckout(
      {
        parent,
        workerId: 'recovery',
        request: { agent: 'alpha', prompt: 'edit' },
        signal: new AbortController().signal,
        onCheckout: (value) => {
          checkout = value
        },
        execute: async () => {
          throw new Error('inference must not start')
        },
      },
      {
        ...dependencies,
        allocate: async (input) => {
          const worktree = await dependencies.allocate(input)
          throw new WorktreeAllocationError('snapshot seed failed', {
            worktree,
            snapshotRef: 'refs/copse/backups/recovery',
          })
        },
        append: async (_projectId, _threadId, message) => {
          notes.push(message.content)
        },
        retire: async () => {
          throw new Error('must not retire an incomplete allocation')
        },
      },
    ),
    /snapshot seed failed/,
  )
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'retained')
  await access(checkout.path)
  assert.match(notes.join('\n'), /refs\/copse\/backups\/recovery/)
})

it('branches from an already isolated parent and carries its dirty files without changing either parent checkout', async () => {
  const { parent, dependencies } = await setup()
  git(parent.root, ['config', 'commit.gpgsign', 'false'])
  const parentWorktree = await allocateThreadWorktree({
    projectId: parent.projectId,
    threadId: 'upstream',
    projectRoot: parent.root,
    prompt: 'parent',
    baseBranch: 'main',
  })
  await writeFile(join(parentWorktree.path, 'same.txt'), 'parent work in progress')
  let checkout: WorkerCheckout | undefined
  await runInIsolatedWorkerCheckout(
    {
      parent: {
        ...parent,
        threadId: 'upstream',
        root: parentWorktree.path,
        checkoutMode: 'worktree',
        branch: parentWorktree.branch,
      },
      workerId: 'nested-checkout',
      request: { agent: 'alpha', prompt: 'inspect parent changes' },
      signal: new AbortController().signal,
      onCheckout: (value) => {
        checkout = value
      },
      execute: async () => {
        const context = getThreadExecutionContext()
        assert.ok(context)
        assert.equal(
          await readFile(join(context.root, 'same.txt'), 'utf8'),
          'parent work in progress',
        )
        return 'inspected'
      },
    },
    dependencies,
  )
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'retained')
  assert.equal(
    await readFile(join(parentWorktree.path, 'same.txt'), 'utf8'),
    'parent work in progress',
  )
  assert.equal(await readFile(join(parent.root, 'same.txt'), 'utf8'), 'parent')
})

it('retains clean checkouts when detached hooks can outlive the worker without waiting for those hooks', async () => {
  const { parent, dependencies } = await setup()
  let enabled = true
  let checkout: WorkerCheckout | undefined
  await runInIsolatedWorkerCheckout(
    {
      parent,
      workerId: 'detached-hooks',
      request: { agent: 'alpha', prompt: 'inspect' },
      signal: new AbortController().signal,
      onCheckout: (value) => {
        checkout = value
      },
      execute: async () => {
        enabled = false
        return 'report'
      },
    },
    {
      ...dependencies,
      detachedHooksEnabled: () => enabled,
      retire: async () => {
        throw new Error('detached hooks may still write; do not retire')
      },
    },
  )
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'retained')
  assert.equal(checkout.error, undefined)
  await access(checkout.path)
})

it('retains a clean checkout whose worker left edits staged for approval', async () => {
  const { parent, dependencies, saved } = await setup()
  let checkout: WorkerCheckout | undefined
  await runInIsolatedWorkerCheckout(
    {
      parent,
      workerId: 'staged-only',
      request: { agent: 'alpha', prompt: 'edit' },
      signal: new AbortController().signal,
      onCheckout: (value) => {
        checkout = value
      },
      execute: async () => {
        await stageDiff('pending.txt', '', 'staged', 'plaintext')
        return 'staged for approval'
      },
    },
    dependencies,
  )
  assert.ok(checkout)
  assert.equal(checkout.cleanup, 'retained')
  await access(checkout.path)
  assert.equal(saved.get('staged-only')?.archivedAt, undefined)
  assert.equal(
    getStagedDiffEntry('pending.txt', { projectId: parent.projectId, threadId: 'staged-only' })
      ?.after,
    'staged',
  )
})

it('archives the worker chat when allocation fails before any checkout exists', async () => {
  const { parent, dependencies, saved } = await setup()
  let checkout: WorkerCheckout | undefined
  await assert.rejects(
    runInIsolatedWorkerCheckout(
      {
        parent,
        workerId: 'unallocated',
        request: { agent: 'alpha', prompt: 'edit' },
        signal: new AbortController().signal,
        onCheckout: (value) => {
          checkout = value
        },
        execute: async () => {
          throw new Error('inference must not start')
        },
      },
      {
        ...dependencies,
        allocate: async () => {
          throw new Error('branch already exists')
        },
      },
    ),
    /branch already exists/,
  )
  assert.equal(checkout, undefined)
  const thread = saved.get('unallocated')
  assert.ok(thread)
  assert.equal(thread.status, 'error')
  assert.equal(typeof thread.archivedAt, 'number')
})
