import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialiseCheckouts } from './checkouts.ts'
import { createTestRepo, worktreeCount, type TestRepo } from './test-repo.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('materialiseCheckouts', () => {
  let repo: TestRepo
  let scratch = ''
  let baseCommit = ''
  let headCommit = ''

  before(async () => {
    repo = await createTestRepo({ 'a.txt': 'one\n' })
    baseCommit = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({ 'a.txt': 'two\n' })
    headCommit = repo.commit('change a')
    // Uncommitted: a tracked edit and an untracked file.
    await repo.write({ 'a.txt': 'three\n', 'new/untracked.txt': 'fresh\n' })
    scratch = await mkdtemp(join(tmpdir(), 'review-checkouts-'))
  })

  after(async () => {
    await rm(scratch, { recursive: true, force: true })
    await repo.remove()
  })

  it('checks out the merge-base and head, overlaying the working tree on head', async () => {
    const checkouts = await materialiseCheckouts({
      repoRoot: join(repo.root, 'new'),
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: true,
    })
    try {
      assert.equal(checkouts.mergeBase, baseCommit)
      assert.equal(checkouts.headCommit, headCommit)
      assert.equal(checkouts.dirty, true)
      assert.deepEqual(checkouts.untrackedPaths, ['new/untracked.txt'])
      assert.equal(checkouts.gitCommonDir, await realpath(join(repo.root, '.git')))
      assert.equal(await readFile(join(checkouts.base, 'a.txt'), 'utf8'), 'one\n')
      assert.equal(await readFile(join(checkouts.head, 'a.txt'), 'utf8'), 'three\n')
      assert.equal(await readFile(join(checkouts.head, 'new/untracked.txt'), 'utf8'), 'fresh\n')
      assert.equal(await exists(join(checkouts.base, 'new')), false)
      // The user's own tree is untouched.
      assert.equal(await readFile(join(repo.root, 'a.txt'), 'utf8'), 'three\n')
    } finally {
      await checkouts.cleanup()
    }
    assert.equal(await exists(checkouts.base), false)
    assert.equal(await exists(checkouts.head), false)
    assert.equal(await exists(checkouts.reviewHead), false)
    assert.equal(worktreeCount(repo), 1)
  })

  it('leaves head at the commit when the working tree is excluded', async () => {
    const checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: false,
    })
    try {
      assert.equal(checkouts.dirty, false)
      assert.deepEqual(checkouts.untrackedPaths, [])
      assert.equal(await readFile(join(checkouts.head, 'a.txt'), 'utf8'), 'two\n')
      assert.equal(await exists(join(checkouts.head, 'new')), false)
    } finally {
      await checkouts.cleanup()
    }
  })

  it('reviews another ref as committed, never overlaying the working tree on it', async () => {
    // A contributor's branch: fetched under its own ref, HEAD stays on feature.
    repo.git('branch', 'contrib', headCommit)
    repo.git('update-ref', 'refs/pull/7/head', 'contrib')
    const checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      headRef: 'refs/pull/7/head',
      scratchDir: scratch,
      includeWorkingTree: true,
    })
    try {
      assert.equal(checkouts.headCommit, headCommit)
      assert.equal(checkouts.mergeBase, baseCommit)
      assert.equal(checkouts.dirty, false)
      assert.deepEqual(checkouts.untrackedPaths, [])
      assert.equal(await readFile(join(checkouts.head, 'a.txt'), 'utf8'), 'two\n')
      assert.equal(await exists(join(checkouts.head, 'new')), false)
    } finally {
      await checkouts.cleanup()
    }
    await assert.rejects(
      materialiseCheckouts({
        repoRoot: repo.root,
        baseRef: 'main',
        headRef: 'refs/pull/8/head',
        scratchDir: scratch,
        includeWorkingTree: false,
      }),
      /Cannot resolve refs\/pull\/8\/head/,
    )
  })

  it('never runs a repository hook on the host', async () => {
    // A hook the repository controls, wired through its own config the way a
    // hostile checkout would do it. Materialising must not run it.
    await repo.write({
      'hooks/post-checkout': '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/HOOK_RAN"\n',
    })
    await chmod(join(repo.root, 'hooks/post-checkout'), 0o755)
    repo.git('config', 'core.hooksPath', 'hooks')
    const checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: false,
    })
    await checkouts.cleanup()
    assert.equal(await exists(join(repo.root, 'HOOK_RAN')), false, 'the post-checkout hook ran')
  })

  it('fails cleanly on a ref that does not exist', async () => {
    await assert.rejects(
      materialiseCheckouts({
        repoRoot: repo.root,
        baseRef: 'no-such-branch',
        scratchDir: scratch,
        includeWorkingTree: false,
      }),
      /merge-base/,
    )
    assert.equal(await exists(join(scratch, 'base')), false)
  })
})
