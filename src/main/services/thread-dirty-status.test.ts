import { describe, it, before, after, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  threadHasUncommittedChanges,
  resetThreadDirtyStatusCacheForTest,
} from './thread-dirty-status.ts'
import { setGitAvailableForTest } from './tool-availability.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

describe('threadHasUncommittedChanges', { skip: !gitOk && 'git not installed' }, () => {
  let dir = ''
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: dir })
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'copse-thread-dirty-status-'))
    setGitAvailableForTest(true)
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'README.md'), 'hello\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
  })

  afterEach(() => {
    mock.timers.reset()
    resetThreadDirtyStatusCacheForTest()
  })

  after(async () => {
    setGitAvailableForTest(null)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('reports false for a clean checkout', async () => {
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 1), false)
  })

  it('reports true once the worktree has an unstaged edit', async () => {
    await writeFile(join(dir, 'README.md'), 'hello again\n')
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 2), true)
  })

  it('serves a cached answer for the same updatedAt within the recheck window', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    await writeFile(join(dir, 'README.md'), 'hello again\n')
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 3), true)

    git('checkout', '--', 'README.md')

    // Same updatedAt as the cached entry, inside the window: the cached "true"
    // is served rather than re-running git status on every poll.
    mock.timers.tick(29_000)
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 3), true)

    // A new updatedAt busts the cache and observes the real, clean state.
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 4), false)
  })

  it('re-checks a commit or discard that left updatedAt unchanged once the window passes', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    await writeFile(join(dir, 'README.md'), 'hello again\n')
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 6), true)

    // Discarded outside the thread, so its metadata timestamp never moves.
    git('checkout', '--', 'README.md')

    mock.timers.tick(30_000)
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 6), false)
  })

  it("keys the cache by thread id, so one thread never serves another one's cached answer", async () => {
    await writeFile(join(dir, 'README.md'), 'hello again\n')
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 5), true)

    git('checkout', '--', 'README.md')

    // Same root and same updatedAt as thread-1's cached "true" above, but a
    // different thread id: must observe the real, clean state rather than
    // reusing thread-1's entry.
    assert.equal(await threadHasUncommittedChanges('thread-2', dir, 5), false)
  })
})
