import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import { createThread, getThreadMeta, updateMeta } from './thread-store.ts'
import { allocateThreadWorktree } from './worktree-manager.ts'
import { listWorktreeInventory, measureWorktreeSize, removeWorktree } from './worktree-inventory.ts'

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

const NO_RUNS: ReadonlySet<string> = new Set<string>()

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('worktree inventory', () => {
  const cleanups: string[] = []
  let previousWorktrees: string | undefined
  let previousWorkspace: string | undefined

  /** A repository plus a Copse-allocated checkout for `thread-1`, with its thread on disk. */
  async function setup(): Promise<{ repo: string; worktreePath: string; branch: string }> {
    previousWorktrees = process.env['COPSE_WORKTREES_DIR']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-worktree-inventory-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    process.env['COPSE_WORKSPACE_DIR'] = join(temp, 'workspace')
    setGitAvailableForTest(true)

    const repo = join(temp, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])

    await createThread('project-1', thread('thread-1', 'Fix the flicker'))
    const worktree = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      prompt: 'Fix the flicker',
      baseBranch: 'main',
    })
    await updateMeta('project-1', 'thread-1', { worktree, gitBranch: worktree.branch })
    return { repo, worktreePath: worktree.path, branch: worktree.branch }
  }

  afterEach(async () => {
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    previousWorktrees = undefined
    previousWorkspace = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('lists a managed checkout with the thread that owns it', async () => {
    const { repo, worktreePath, branch } = await setup()

    const entries = await listWorktreeInventory({
      projectId: 'project-1',
      projectRoot: repo,
      runningThreadIds: NO_RUNS,
    })

    assert.equal(entries.length, 1, 'the project checkout itself is not a managed worktree')
    const entry = entries[0]
    assert.ok(entry)
    assert.equal(entry.path, worktreePath)
    assert.equal(entry.branch, branch)
    assert.equal(entry.baseBranch, 'main')
    assert.equal(entry.managed, true)
    assert.deepEqual(entry.usage, {
      threadId: 'thread-1',
      title: 'Fix the flicker',
      updatedAt: 1,
      archived: false,
      linked: true,
      running: false,
    })
    assert.equal(entry.changedCount, 0)
    assert.equal(entry.merged, true, 'a checkout still at its base commit is contained by it')
    assert.ok(entry.lastUsedAt !== null && entry.lastUsedAt > 0)
    assert.ok(entry.createdAt !== null && entry.createdAt > 0)
  })

  it('uses a surviving checkout under the project parent when the selected worktree is gone', async () => {
    const { repo, worktreePath } = await setup()
    await createThread('project-1', thread('thread-2', 'Keep the repository reachable'))
    const sibling = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-2',
      projectRoot: worktreePath,
      prompt: 'Keep the repository reachable',
      baseBranch: 'main',
    })
    await updateMeta('project-1', 'thread-2', { worktree: sibling, gitBranch: sibling.branch })

    // Reproduce a project opened from a linked checkout that was removed behind
    // Copse's back. Its Git registration may already have been pruned, while
    // the per-project parent and another child remain available.
    await rm(worktreePath, { recursive: true, force: true })
    git(repo, ['worktree', 'prune'])

    const entries = await listWorktreeInventory({
      projectId: 'project-1',
      projectRoot: worktreePath,
      runningThreadIds: NO_RUNS,
    })

    assert.ok(entries.some((entry) => entry.path === sibling.path))
    assert.ok(
      !entries.some((entry) => entry.path === worktreePath),
      'the selected checkout is not storage the project can delete',
    )
    assert.ok(
      !entries.some((entry) => entry.path === repo),
      'the primary checkout is the parent project, never a removable worktree',
    )
    const size = await measureWorktreeSize({
      projectId: 'project-1',
      projectRoot: worktreePath,
      path: sibling.path,
    })
    assert.equal(size.path, sibling.path)
  })

  it('reports a checkout whose thread no longer points at it as released', async () => {
    const { repo, worktreePath } = await setup()
    await updateMeta('project-1', 'thread-1', {
      worktree: {
        path: join(worktreePath, 'elsewhere'),
        branch: 'other',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 2,
        seededFromDirtyProject: false,
      },
    })

    const [entry] = await listWorktreeInventory({
      projectId: 'project-1',
      projectRoot: repo,
      runningThreadIds: NO_RUNS,
    })

    assert.ok(entry)
    assert.equal(entry.usage?.linked, false)
    assert.equal(entry.baseBranch, null, 'stale metadata does not describe this checkout')
  })

  it('flags a running thread and refuses to remove its checkout', async () => {
    const { repo, worktreePath } = await setup()
    const running = new Set(['thread-1'])

    const [entry] = await listWorktreeInventory({
      projectId: 'project-1',
      projectRoot: repo,
      runningThreadIds: running,
    })
    assert.equal(entry?.usage?.running, true)

    const result = await removeWorktree({
      projectId: 'project-1',
      projectRoot: repo,
      path: worktreePath,
      force: true,
      runningThreadIds: running,
    })

    assert.deepEqual(result, {
      status: 'blocked-running',
      path: worktreePath,
      threadId: 'thread-1',
    })
    assert.ok(existsSync(worktreePath), 'a running turn keeps its checkout')
  })

  it('measures the working tree, ignored files included', async () => {
    const { repo, worktreePath } = await setup()
    await writeFile(join(worktreePath, 'build.log'), 'x'.repeat(4096))

    const size = await measureWorktreeSize({
      projectId: 'project-1',
      projectRoot: repo,
      path: worktreePath,
    })

    assert.equal(size.path, worktreePath)
    assert.equal(size.truncated, false)
    assert.ok(size.bytes >= 4096, `expected the log to count, got ${String(size.bytes)}`)
    assert.ok(size.fileCount >= 2)
  })

  it('refuses a path this repository has not registered', async () => {
    const { repo } = await setup()
    await assert.rejects(
      measureWorktreeSize({
        projectId: 'project-1',
        projectRoot: repo,
        path: join(repo, '..', 'elsewhere'),
      }),
      /not registered with this repository/,
    )
  })

  it('reports uncommitted work before deleting, then removes it once forced', async () => {
    const { repo, worktreePath, branch } = await setup()
    await writeFile(join(worktreePath, 'scratch.txt'), 'work in progress\n')

    const blocked = await removeWorktree({
      projectId: 'project-1',
      projectRoot: repo,
      path: worktreePath,
      force: false,
      runningThreadIds: NO_RUNS,
    })
    assert.equal(blocked.status, 'blocked-dirty')
    assert.deepEqual(blocked.changed, ['scratch.txt'])
    assert.ok(existsSync(worktreePath), 'an unforced delete leaves the checkout alone')

    const removed = await removeWorktree({
      projectId: 'project-1',
      projectRoot: repo,
      path: worktreePath,
      force: true,
      runningThreadIds: NO_RUNS,
    })

    assert.deepEqual(removed, {
      status: 'removed',
      path: worktreePath,
      branch,
      branchDeleted: true,
    })
    assert.equal(existsSync(worktreePath), false)
    assert.equal(
      git(repo, ['branch', '--list', branch]).trim(),
      '',
      'a fully merged branch goes with its checkout',
    )
    const meta = await getThreadMeta('project-1', 'thread-1')
    assert.equal(meta?.worktree, undefined, 'the thread reverts to the project checkout')
    assert.equal(meta?.title, 'Fix the flicker', 'the rest of the thread is untouched')
  })

  it('keeps a branch that still carries unmerged commits', async () => {
    const { repo, worktreePath, branch } = await setup()
    await writeFile(join(worktreePath, 'feature.txt'), 'new\n')
    git(worktreePath, ['add', '.'])
    git(worktreePath, ['commit', '-q', '-m', 'feature'])

    const [entry] = await listWorktreeInventory({
      projectId: 'project-1',
      projectRoot: repo,
      runningThreadIds: NO_RUNS,
    })
    assert.equal(entry?.merged, false)

    const removed = await removeWorktree({
      projectId: 'project-1',
      projectRoot: repo,
      path: worktreePath,
      force: false,
      runningThreadIds: NO_RUNS,
    })

    assert.equal(removed.status, 'removed')
    assert.equal(removed.branchDeleted, false)
    assert.equal(
      git(repo, ['branch', '--list', branch]).trim().replace('*', '').trim(),
      branch,
      'the commit survives its checkout',
    )
  })
})
