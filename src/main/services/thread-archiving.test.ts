import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  truncate,
  rm,
  writeFile,
} from 'node:fs/promises'
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
import { createThreadResource } from './thread-resource-fence.ts'
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
    confirmation: string | null = null,
  ): Promise<import('@shared/threads/archive-thread.ts').ThreadArchiveResult> =>
    archiveStoredThread('project', 'thread', confirmation, runtime, dependencies)

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
    assert.equal((await archive(blocked.fingerprint)).status, 'archived')
    assert.equal(disposals, 1)
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
    assert.ok(git(repo, ['branch', '--list', worktree.branch]))
  })

  it('retains the live renamed branch and its latest commit when restoring', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    git(worktree.path, ['checkout', '-qb', 'renamed-live'])
    await writeFile(join(worktree.path, 'latest.txt'), 'latest\n')
    git(worktree.path, ['add', '.'])
    git(worktree.path, ['commit', '-qm', 'latest live work'])
    const head = git(worktree.path, ['rev-parse', 'HEAD'])
    await archive()
    const stored = await getThreadMeta('project', 'thread')
    assert.ok(stored?.worktree)
    assert.equal(stored.worktree.branch, 'renamed-live')
    assert.equal(stored.gitBranch, 'renamed-live')
    const restored = await restoreRetiredThreadWorktree({
      projectId: 'project',
      threadId: 'thread',
      projectRoot: repo,
      worktree: stored.worktree,
    })
    assert.equal(git(restored.path, ['rev-parse', 'HEAD']), head)
  })

  it('does not remove edits made during awaited ACP disposal or leave false retirement', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    dependencies.disposeAcp = async (): Promise<void> => {
      await writeFile(join(worktree.path, 'late.txt'), 'not approved\n')
    }
    assert.equal((await archive()).status, 'blocked-dirty')
    assert.equal(await readFile(join(worktree.path, 'late.txt'), 'utf8'), 'not approved\n')
    assert.equal((await getThreadMeta('project', 'thread'))?.worktree?.retiredAt, undefined)
  })

  it('refuses an unregistered retired checkout that still exists', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    const parked = worktree.path + '-parked'
    await rename(worktree.path, parked)
    git(repo, ['worktree', 'prune', '--expire', 'now'])
    await rename(parked, worktree.path)
    await updateMetaOrThrow('project', 'thread', { worktree: { ...worktree, retiredAt: 123 } })
    await assert.rejects(archive(), /still exists|unregistered/)
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
    assert.equal(await readFile(join(worktree.path, 'README.md'), 'utf8'), 'base\n')
    await rename(worktree.path, parked)
    await writeFile(worktree.path, 'unregistered replacement file\n')
    await assert.rejects(archive(), /still exists|unregistered/)
    assert.equal(await readFile(worktree.path, 'utf8'), 'unregistered replacement file\n')
    await rm(worktree.path)
    await symlink(parked, worktree.path)
    await assert.rejects(archive(), /symlink/)
    assert.equal((await lstat(worktree.path)).isSymbolicLink(), true)
    assert.equal((await getThreadMeta('project', 'thread'))?.archivedAt, undefined)
  })

  it('rolls retirement back when final content inspection cannot safely complete', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    dependencies.disposeAcp = async (): Promise<void> => {
      await writeFile(join(worktree.path, 'large.txt'), '')
      await truncate(join(worktree.path, 'large.txt'), 64 * 1024 * 1024 + 1)
    }
    await assert.rejects(archive(), /Too much file content/)
    assert.ok(await lstat(worktree.path))
    assert.equal((await getThreadMeta('project', 'thread'))?.worktree?.retiredAt, undefined)
  })

  it('archives a clean checkout whose tracked index exceeds the ordinary command display cap', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    await Promise.all(
      Array.from({ length: 800 }, (_, index) =>
        writeFile(join(worktree.path, `entry-${String(index)}-${'x'.repeat(110)}.txt`), ''),
      ),
    )
    git(worktree.path, ['add', '.'])
    git(worktree.path, ['commit', '-qm', 'large clean index'])
    assert.ok(Buffer.byteLength(git(worktree.path, ['ls-files', '--stage', '-z'])) > 100 * 1024)
    assert.equal((await archive()).status, 'archived')
  })

  it('requires fresh consent for new paths and changes to an already listed file', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    await writeFile(join(worktree.path, 'README.md'), 'first edit\n')
    const first = await archive()
    assert.equal(first.status, 'blocked-dirty')
    await writeFile(join(worktree.path, 'README.md'), 'second edit\n')
    const second = await archive(first.fingerprint)
    assert.equal(second.status, 'blocked-dirty')
    assert.notEqual(second.fingerprint, first.fingerprint)
    assert.equal((await getThreadMeta('project', 'thread'))?.worktree?.retiredAt, undefined)
    await writeFile(join(worktree.path, 'new.txt'), 'new draft\n')
    const third = await archive(second.fingerprint)
    assert.equal(third.status, 'blocked-dirty')
    assert.ok(third.paths.includes('new.txt'))
    assert.equal((await archive(third.fingerprint)).status, 'archived')
  })

  it('binds ignored nested content and symlink targets without following external files', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    await writeFile(join(worktree.path, '.gitignore'), 'build/\n')
    git(worktree.path, ['add', '.gitignore'])
    git(worktree.path, ['commit', '-qm', 'ignore build'])
    await mkdir(join(worktree.path, 'build'))
    await writeFile(join(worktree.path, 'build/draft.txt'), 'first ignored draft\n')
    await symlink(join(root, 'outside-not-present'), join(worktree.path, 'build/link'))
    const preview = await archive()
    assert.equal(preview.status, 'blocked-dirty')
    await writeFile(join(worktree.path, 'build/draft.txt'), 'changed ignored draft\n')
    const refreshed = await archive(preview.fingerprint)
    assert.equal(refreshed.status, 'blocked-dirty')
    assert.notEqual(refreshed.fingerprint, preview.fingerprint)
    assert.equal((await archive(refreshed.fingerprint)).status, 'archived')
  })

  it('rejects invalid resource owner IDs before any creation or metadata lookup', async () => {
    let created = false
    for (const owner of [
      { projectId: '../escape', threadId: 'thread' },
      { projectId: 'project', threadId: '../escape' },
    ]) {
      await assert.rejects(
        createThreadResource(owner, async () => {
          created = true
        }),
        /Invalid thread resource owner/,
      )
    }
    assert.equal(created, false)
  })

  it('waits through resource registration, then refuses archive while the process is live', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const creation = createThreadResource(
      { projectId: 'project', threadId: 'thread' },
      async () => {
        entered.resolve(undefined)
        await release.promise
        processes = true
      },
    )
    await entered.promise
    const archival = archive()
    release.resolve(undefined)
    await creation
    assert.equal((await archival).status, 'blocked-running')
    assert.ok(await lstat(worktree.path))
  })

  it('refuses queued resource creation after archive rather than restoring the retired checkout', async () => {
    const { worktree } = await seed()
    assert.ok(worktree)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    dependencies.disposeAcp = async (): Promise<void> => {
      entered.resolve(undefined)
      await release.promise
    }
    const archival = archive()
    await entered.promise
    let created = false
    const creation = createThreadResource(
      { projectId: 'project', threadId: 'thread' },
      async () => {
        created = true
      },
    )
    const rejected = assert.rejects(creation, /no longer available/)
    release.resolve(undefined)
    assert.equal((await archival).status, 'archived')
    await rejected
    assert.equal(created, false)
    await assert.rejects(lstat(worktree.path), { code: 'ENOENT' })
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
    assert.deepEqual(await archive('f'.repeat(64)), { status: 'blocked-running' })
    assert.equal(releases, 0)
    acquired = true
    processes = true
    assert.deepEqual(await archive('f'.repeat(64)), { status: 'blocked-running' })
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
      await beforeRemove(_input.worktree)
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
