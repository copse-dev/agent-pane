import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import type { GhPrDetails } from '@shared/types/git.ts'
import {
  ARCHIVE_DAY_MS,
  autoArchiveDays,
  type ThreadAutoArchived,
} from '@shared/threads/auto-archive.ts'
import { ThreadAutoArchive, type AutoArchiveDependencies } from './thread-auto-archive.ts'
import { inspectAutoArchiveCheckout, checkoutStillClean } from './thread-auto-archive-git.ts'
import {
  getThreadMeta,
  getProjectThread,
  loadProjectThreadMetas,
  saveProjectThread,
  updateMetaIfUnchanged,
  updateMetaOrThrow,
} from './thread-store.ts'
import { allocateThreadWorktree } from './worktree-manager.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('finished-thread auto archive with real Git and thread store', () => {
  let root: string
  let repo: string
  let worktreePath: string
  let previousWorkspace: string | undefined
  let previousWorktrees: string | undefined
  let now: number
  let days: number
  let busy: boolean
  let active: boolean
  let viewed: boolean
  let pr: GhPrDetails
  let deps: AutoArchiveDependencies
  let service: ThreadAutoArchive
  let events: ThreadAutoArchived[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-auto-archive-'))
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    previousWorktrees = process.env['COPSE_WORKTREES_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
    process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
    setGitAvailableForTest(true)
    repo = join(root, 'repo')
    await mkdir(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'user.email', 'test@example.invalid'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n.tmp/\nprivate.txt\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const worktree = await allocateThreadWorktree({
      projectId: 'project',
      threadId: 'thread',
      projectRoot: repo,
      prompt: 'Archive test',
      baseBranch: 'main',
      seedFromDirtyProject: false,
    })
    worktreePath = worktree.path
    await writeFile(join(worktreePath, 'README.md'), 'finished\n')
    git(worktreePath, ['add', '.'])
    git(worktreePath, ['commit', '-qm', 'feature'])
    const head = git(worktreePath, ['rev-parse', 'HEAD'])
    const remote = join(root, 'origin.git')
    git(repo, ['init', '--bare', '-q', remote])
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '-q', 'origin', 'main', worktree.branch])
    git(repo, ['merge', '--squash', worktree.branch])
    git(repo, ['commit', '-qm', 'squash feature'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['--git-dir', remote, 'update-ref', '-d', `refs/heads/${worktree.branch}`])
    git(repo, ['fetch', '-q', '--prune', 'origin'])
    // No remote-tracking source branch survives; the original commit is absent
    // from main. This is exactly where the prototype's unpushed check failed.
    assert.notEqual(git(repo, ['rev-parse', 'HEAD']), head)
    assert.equal(git(repo, ['branch', '-r', '--contains', head]), '')
    now = Date.UTC(2026, 9, 19)
    days = 3
    busy = false
    active = false
    viewed = false
    events = []
    pr = {
      owner: 'owner',
      repo: 'repo',
      number: 1,
      title: 'Feature',
      url: 'https://github.com/owner/repo/pull/1',
      state: 'MERGED',
      body: '',
      files: [],
      headRefOid: head,
      mergedAt: new Date(now - 4 * ARCHIVE_DAY_MS).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    const thread: Thread = {
      id: 'thread',
      title: 'Finished task',
      status: 'idle',
      messages: [
        {
          id: 'message',
          role: 'user',
          content: 'Keep this transcript',
          toolCalls: [],
          createdAt: 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: now - 4 * ARCHIVE_DAY_MS,
      worktree,
      prRefs: [{ owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url }],
    }
    await saveProjectThread('project', thread)
    deps = {
      now: (): number => now,
      days: (): number => days,
      root: (): string => repo,
      list: loadProjectThreadMetas,
      get: getThreadMeta,
      update: updateMetaIfUnchanged,
      pr: async (): Promise<GhPrDetails> => pr,
      inspect: inspectAutoArchiveCheckout,
      unchanged: checkoutStillClean,
      busy: (): boolean => busy,
    }
    service = new ThreadAutoArchive(
      {
        begin: (): boolean => !active,
        end: (): void => {},
        isAgentActive: (): boolean => active,
        isViewed: (): boolean => viewed,
        stopAgent: async (): Promise<void> => {},
      },
      deps,
    )
  })

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    await rm(root, { recursive: true, force: true })
  })

  const sweep = async (): Promise<void> => service.sweep(['project'], (event) => events.push(event))
  const archived = async (): Promise<boolean> =>
    (await getThreadMeta('project', 'thread'))?.archivedAt !== undefined

  it('archives a squash-merged checkout without its remote branch, preserves files, and restores after restart', async () => {
    await mkdir(join(worktreePath, 'node_modules'))
    await writeFile(join(worktreePath, 'node_modules', 'package.txt'), 'generated')
    await sweep()
    assert.equal(await archived(), true)
    assert.equal(events.length, 1)
    assert.equal(await readFile(join(worktreePath, 'README.md'), 'utf8'), 'finished\n')
    assert.equal(
      (await getProjectThread('project', 'thread'))?.messages[0]?.content,
      'Keep this transcript',
    )
    assert.equal((await loadProjectThreadMetas('project', { includeArchived: false })).length, 0)
    const restarted = new ThreadAutoArchive(
      {
        begin: (): boolean => true,
        end: (): void => {},
        isAgentActive: (): boolean => false,
        isViewed: (): boolean => false,
        stopAgent: async (): Promise<void> => {},
      },
      deps,
    )
    assert.equal(await restarted.decide('project', 'thread', 'restore'), true)
    assert.equal(await archived(), false)
    assert.equal((await getThreadMeta('project', 'thread'))?.updatedAt, now)
    await sweep()
    assert.equal(events.length, 1)
  })

  it('uses mergedAt rather than a later comment updatedAt', async () => {
    await sweep()
    assert.equal(await archived(), true)
  })

  it('readiness checks never archive and open threads remain visible', async () => {
    await service.sweep(
      ['project'],
      (event) => {
        events.push(event)
      },
      false,
    )
    assert.equal(await archived(), false)
    viewed = true
    await sweep()
    assert.equal(await archived(), false)
    viewed = false
    await sweep()
    assert.equal(await archived(), true)
  })

  it('rechecks whether the user opened the thread at the serialized write', async () => {
    deps.update = (pid, tid, expected, patch, allowed): Promise<boolean> => {
      viewed = true
      return updateMetaIfUnchanged(pid, tid, expected, patch, allowed)
    }
    await sweep()
    assert.equal(await archived(), false)
    assert.deepEqual(events, [])
  })

  it('waits for an in-flight readiness check before running the next sweep', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    deps.pr = async (): Promise<GhPrDetails> => {
      entered.resolve(undefined)
      await release.promise
      return pr
    }
    const readiness = service.sweep(
      ['project'],
      (event) => {
        events.push(event)
      },
      false,
    )
    await entered.promise
    const automatic = sweep()
    release.resolve(undefined)
    await Promise.all([readiness, automatic])
    assert.equal(await archived(), true)
    assert.equal(events.length, 1)
  })

  it('requires review for a shared checkout even when every linked PR is merged', async () => {
    const saved = await getProjectThread('project', 'thread')
    assert.ok(saved)
    delete saved.worktree
    await saveProjectThread('project', saved)
    await sweep()
    assert.equal(await archived(), false)
    assert.equal(service.review('project').length, 1)
  })

  it('keeps a parent visible until its side chats have been archived', async () => {
    const parent = await getProjectThread('project', 'thread')
    assert.ok(parent)
    const { worktree: _worktree, ...side } = parent
    await saveProjectThread('project', {
      ...side,
      id: 'side',
      sideChat: { parentThreadId: 'thread', anchorMessageId: 'message' },
    })
    await sweep()
    assert.equal(await archived(), false)
    assert.equal(await service.decide('project', 'thread', 'archive'), false)
    assert.equal(await service.decide('project', 'side', 'archive'), true)
    assert.equal(await service.decide('project', 'thread', 'archive'), true)
  })

  it('rechecks the checkout and a changed setting before writing', async () => {
    deps.unchanged = async (): Promise<boolean> => false
    await sweep()
    assert.equal(await archived(), false)
    deps.unchanged = async (): Promise<boolean> => {
      days = 0
      return true
    }
    await sweep()
    assert.equal(await archived(), false)
    assert.deepEqual(events, [])
  })

  it('waits three full days after the actual merge', async () => {
    pr.mergedAt = new Date(now - 3 * ARCHIVE_DAY_MS + 1).toISOString()
    await sweep()
    assert.equal(await archived(), false)
    now++
    await sweep()
    assert.equal(await archived(), true)
  })

  it('supports disabling and longer delays', async () => {
    days = 0
    await sweep()
    assert.equal(await archived(), false)
    days = 7
    await sweep()
    assert.equal(await archived(), false)
    now += 4 * ARCHIVE_DAY_MS
    await sweep()
    assert.equal(await archived(), true)
  })

  for (const kind of ['tracked', 'untracked', 'ignored', 'extra-commit'] as const) {
    it(`keeps ${kind} local work visible for review`, async () => {
      await writeFile(
        join(
          worktreePath,
          kind === 'tracked' ? 'README.md' : kind === 'ignored' ? 'private.txt' : 'notes.txt',
        ),
        'unfinished',
      )
      if (kind === 'extra-commit') {
        git(worktreePath, ['add', '.'])
        git(worktreePath, ['commit', '-qm', 'extra'])
      }
      await sweep()
      assert.equal(await archived(), false)
      assert.equal(service.review('project').length, 1)
    })
  }

  for (const patch of [
    { status: 'running' as const },
    { unreadAt: 1 },
    { draftPrompt: 'unfinished' },
  ]) {
    it(`does not archive active/unread/draft metadata ${JSON.stringify(patch)}`, async () => {
      await updateMetaOrThrow('project', 'thread', patch)
      await sweep()
      assert.equal(await archived(), false)
    })
  }

  it('excludes runtime activity and pending diffs even with idle metadata', async () => {
    busy = true
    await sweep()
    assert.equal(await archived(), false)
    busy = false
    active = true
    await sweep()
    assert.equal(await archived(), false)
  })

  it('fails closed on missing merge times and unavailable PRs', async () => {
    delete pr.mergedAt
    await sweep()
    assert.equal(await archived(), false)
    assert.equal(service.review('project').length, 1)
    deps.pr = async (): Promise<never> => {
      throw new Error('offline')
    }
    await sweep()
    assert.equal(await archived(), false)
  })

  it('checks all linked PRs', async () => {
    await updateMetaOrThrow('project', 'thread', {
      prRefs: [
        { owner: 'owner', repo: 'repo', number: 1, url: pr.url },
        { owner: 'owner', repo: 'repo', number: 2, url: 'https://github.com/owner/repo/pull/2' },
      ],
    })
    deps.pr = async (_root, ref): Promise<GhPrDetails> =>
      ref.number === 1 ? pr : { ...pr, number: 2, state: 'OPEN' }
    await sweep()
    assert.equal(await archived(), false)
  })

  it('rechecks metadata after asynchronous Git work', async () => {
    deps.inspect = async (...args): ReturnType<typeof inspectAutoArchiveCheckout> => {
      const result = await inspectAutoArchiveCheckout(...args)
      await updateMetaOrThrow('project', 'thread', { draftPrompt: 'new work', updatedAt: now })
      return result
    }
    await sweep()
    assert.equal(await archived(), false)
    assert.deepEqual(events, [])
  })

  it('rechecks pending diffs at the serialized write', async () => {
    deps.update = (pid, tid, expected, patch, allowed): Promise<boolean> => {
      busy = true
      return updateMetaIfUnchanged(pid, tid, expected, patch, allowed)
    }
    await sweep()
    assert.equal(await archived(), false)
    assert.deepEqual(events, [])
  })

  it('Keep restarts the review delay and explicit Archive preserves uncertain work', async () => {
    pr.state = 'OPEN'
    await sweep()
    assert.equal(service.review('project').length, 1)
    assert.equal(await service.decide('project', 'thread', 'keep'), true)
    await sweep()
    assert.equal(service.review('project').length, 0)
    await writeFile(join(worktreePath, 'notes.txt'), 'keep me')
    assert.equal(await service.decide('project', 'thread', 'archive'), true)
    assert.equal(await readFile(join(worktreePath, 'notes.txt'), 'utf8'), 'keep me')
  })
})

it('defaults to three days and refuses shorter or malformed delays', () => {
  for (const value of [undefined, null, -1, 1, 2, NaN, '7', 3.5])
    assert.equal(autoArchiveDays(value), 3)
  assert.equal(autoArchiveDays(0), 0)
  assert.equal(autoArchiveDays(7), 7)
})
