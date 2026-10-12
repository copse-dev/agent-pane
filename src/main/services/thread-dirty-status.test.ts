import { describe, it, before, after, afterEach } from 'node:test'
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

  it('serves a cached answer for the same updatedAt, even after the diff is reverted', async () => {
    await writeFile(join(dir, 'README.md'), 'hello again\n')
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 3), true)

    git('checkout', '--', 'README.md')

    // Same updatedAt as the cached entry: the stale "true" is served rather
    // than re-running git status — the point of caching against the thread's
    // own timestamp rather than polling interval.
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 3), true)

    // A new updatedAt busts the cache and observes the real, clean state.
    assert.equal(await threadHasUncommittedChanges('thread-1', dir, 4), false)
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
