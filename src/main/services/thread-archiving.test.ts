import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import {
  archiveStoredThread,
  type ThreadArchivingDependencies,
  type ThreadArchivingRuntime,
} from './thread-archiving.ts'
import {
  getProjectThread,
  getThreadMeta,
  saveProjectThread,
  updateMetaOrThrow,
} from './thread-store.ts'
import {
  allocateThreadWorktree,
  archiveThreadWorktree,
  restoreRetiredThreadWorktree,
} from './worktree-manager.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('archiveStoredThread', () => {
  let root: string
  let repo: string
  let previousWorktrees: string | undefined
  let previousWorkspace: string | undefined
  let processes: boolean
  let acquired: boolean
  let releases: number
  let disposals: number
  let dependencies: ThreadArchivingDependencies
  const runtime: ThreadArchivingRuntime = {
    begin: () => acquired,
    end: () => {
      releases++
    },
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-thread-archiving-'))
    previousWorktrees = process.env['COPSE_WORKTREES_DIR']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
    process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
    setGitAvailableForTest(true)
    repo = join(root, 'repo')
    await mkdir(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Copse Test'])
    git(repo, ['config', 'user.email', 'copse@example.invalid'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    processes = false
    acquired = true
    releases = 0
    disposals = 0
    dependencies = {
      getMeta: getThreadMeta,
      updateMeta: updateMetaOrThrow,
      projectRoot: (): string => repo,
      hasProcesses: (): boolean => processes,
      disposeAcp: async (): Promise<void> => {
        disposals++
      },
      removeWorktree: archiveThreadWorktree,
    }
  })

  afterEach(async () => {
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    await rm(root, { recursive: true, force: true })
  })

  async function seed(withWorktree = true): Promise<Thread> {
    const worktree = withWorktree
      ? await allocateThreadWorktree({
          projectId: 'project',
          threadId: 'thread',
          projectRoot: repo,
          prompt: 'Archive example',
          baseBranch: 'main',
          seedFromDirtyProject: false,
        })
      : undefined
    const thread: Thread = {
      id: 'thread',
      title: 'Archive example',
      status: 'idle',
      messages: [
        {
          id: 'user',
          role: 'user',
          content: 'Keep this conversation',
          toolCalls: [],
          createdAt: 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
      ...(worktree ? { worktree, gitBranch: worktree.branch, worktreeChoice: 'worktree' } : {}),
    }
    await saveProjectThread('project', thread)
    return thread
  }

  const archive = (
    discard = false,
  ): Promise<import('@shared/threads/archive-thread.ts').ThreadArchiveResult> =>
    archiveStoredThread('project', 'thread', discard, runtime, dependencies)

  it('removes a clean checkout, preserves unmerged commits and transcript, and can rebuild it', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    await writeFile(join(worktree.path, 'committed.txt'), 'keep me\n')
    git(worktree.path, ['add', '.'])
    git(worktree.path, ['commit', '-qm', 'unmerged work'])
    const head = git(worktree.path, ['rev-parse', 'HEAD'])
    const result = await archive()
    assert.equal(result.status, 'archived')
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
    assert.equal(git(repo, ['rev-parse', worktree.branch]), head)
    const stored = await getProjectThread('project', 'thread')
    assert.ok(stored?.archivedAt)
    assert.ok(stored.worktree?.retiredAt)
    assert.equal(stored.messages[0]?.content, 'Keep this conversation')
    const restored = await restoreRetiredThreadWorktree({
      projectId: 'project',
      threadId: 'thread',
      projectRoot: repo,
      worktree: stored.worktree,
    })
    assert.equal(await readFile(join(restored.path, 'committed.txt'), 'utf8'), 'keep me\n')
    assert.equal(releases, 1)
  })

  it('reports tracked, staged, untracked and ignored content; leaves everything until confirmed', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    await writeFile(join(worktree.path, '.gitignore'), 'local.log\n')
    git(worktree.path, ['add', '.gitignore'])
    git(worktree.path, ['commit', '-qm', 'ignore rule'])
    await writeFile(join(worktree.path, 'README.md'), 'edited\n')
    await writeFile(join(worktree.path, 'staged.txt'), 'staged\n')
    git(worktree.path, ['add', 'staged.txt'])
    await mkdir(join(worktree.path, 'notes'))
    await writeFile(join(worktree.path, 'notes/draft.txt'), 'draft\n')
    await writeFile(join(worktree.path, 'local.log'), 'ignored\n')
    const blocked = await archive()
    assert.equal(blocked.status, 'blocked-dirty')
    assert.deepEqual(blocked.paths.sort(), [
      'README.md',
      'local.log',
      'notes/draft.txt',
      'staged.txt',
    ])
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
    assert.equal(await readFile(join(worktree.path, 'notes/draft.txt'), 'utf8'), 'draft\n')
    assert.equal(disposals, 0, 'dirty-file preview must leave the agent session intact')
    assert.equal((await archive(true)).status, 'archived')
    assert.equal(disposals, 1)
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
    assert.ok(git(repo, ['branch', '--list', worktree.branch]))
  })

  it('archives a shared chat without touching the project checkout, and retries idempotently', async () => {
    await seed(false)
    const first = await archive()
    assert.equal(first.status, 'archived')
    assert.deepEqual(await archive(), first)
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'base\n')
  })

  it('refuses running agents and processes even when discard is confirmed', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    acquired = false
    assert.deepEqual(await archive(true), { status: 'blocked-running' })
    assert.equal(releases, 0)
    acquired = true
    processes = true
    assert.deepEqual(await archive(true), { status: 'blocked-running' })
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
    assert.ok(await lstat(worktree.path))
    assert.equal(releases, 1)
  })

  it('leaves a chat visible and releases the slot when removal fails', async () => {
    await seed()
    dependencies.removeWorktree = async (): Promise<never> => {
      throw new Error('Cannot remove checkout')
    }
    await assert.rejects(archive(), /Cannot remove checkout/)
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
    assert.equal(releases, 1)
  })

  it('keeps the checkout when retirement cannot be persisted', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    dependencies.updateMeta = async (): Promise<never> => {
      throw new Error('Cannot save retirement')
    }
    await assert.rejects(archive(), /Cannot save retirement/)
    assert.ok(await lstat(worktree.path))
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
  })

  it('retries removal when Git fails after retirement was recorded', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    dependencies.removeWorktree = async (_input, _discard, beforeRemove): Promise<never> => {
      await beforeRemove()
      throw new Error('Git removal failed')
    }
    await assert.rejects(archive(), /Git removal failed/)
    assert.ok(await lstat(worktree.path))
    dependencies.removeWorktree = archiveThreadWorktree
    assert.equal((await archive()).status, 'archived')
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
  })

  it('can retry an archive write without recreating its already removed checkout', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    dependencies.updateMeta = async (projectId, threadId, patch): Promise<void> => {
      if (patch.archivedAt !== undefined) throw new Error('Cannot save archive')
      await updateMetaOrThrow(projectId, threadId, patch)
    }
    await assert.rejects(archive(), /Cannot save archive/)
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
    assert.ok((await getThreadMeta('project', 'thread'))?.worktree?.retiredAt)
    dependencies.updateMeta = updateMetaOrThrow
    assert.equal((await archive()).status, 'archived')
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
  })
})
