import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktreeBackup } from './github/git-service.ts'
import {
  ensureSessionBackup,
  ensureWorktreeRecoverable,
  getSessionBackup,
  resetSessionBackup,
} from './worktree-backup.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
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

describe('createWorktreeBackup', () => {
  let root = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setGitAvailableForTest(true)
    root = await mkdtemp(join(tmpdir(), 'agent-pane-backup-'))
    git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'line1\nline2\n', 'utf-8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'initial'])
    restoreWorkspace = setWorkspaceRootForTest(root)
  })

  afterEach(async () => {
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('captures modified tracked AND untracked files without touching the worktree', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nCHANGED\n', 'utf-8')
    await writeFile(join(root, 'untracked.txt'), 'brand new\n', 'utf-8')
    const statusBefore = git(root, ['status', '--porcelain'])

    const ref = await createWorktreeBackup('test snapshot')
    assert.ok(ref, 'expected a backup ref')
    assert.match(ref, /^refs\/copse\/backups\//)

    // The snapshot commit holds both the modified tracked file and the untracked one.
    assert.equal(git(root, ['show', `${ref}:tracked.txt`]), 'line1\nCHANGED\n')
    assert.equal(git(root, ['show', `${ref}:untracked.txt`]), 'brand new\n')

    // The working tree and index are unchanged — the backup is a side snapshot.
    assert.equal(git(root, ['status', '--porcelain']), statusBefore)
  })

  it('returns null when git is unavailable', async () => {
    setGitAvailableForTest(false)
    assert.equal(await createWorktreeBackup('x'), null)
  })
})

describe('ensureSessionBackup / resetSessionBackup', () => {
  let root = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    resetSessionBackup()
    setGitAvailableForTest(true)
    root = await mkdtemp(join(tmpdir(), 'agent-pane-session-backup-'))
    git(root, ['init'])
    git(root, ['commit', '--allow-empty', '-m', 'initial'])
    restoreWorkspace = setWorkspaceRootForTest(root)
  })

  afterEach(async () => {
    resetSessionBackup()
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('returns null on a clean worktree (nothing to protect)', async () => {
    assert.equal(await ensureSessionBackup(), null)
    assert.equal(getSessionBackup(), null)
  })

  it('takes one backup for a dirty worktree and reuses it until reset', async () => {
    await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')

    const first = await ensureSessionBackup()
    assert.ok(first, 'expected a backup')
    assert.match(first.ref, /^refs\/copse\/backups\//)
    assert.deepEqual(first.paths, ['dirty.txt'])

    // Idempotent within a turn: the same restore point is reused, not re-taken.
    const second = await ensureSessionBackup()
    assert.equal(second, first)
    assert.equal(getSessionBackup(), first)

    // A new turn resets the restore point; the next ensure snapshots afresh.
    resetSessionBackup()
    assert.equal(getSessionBackup(), null)
    const third = await ensureSessionBackup()
    assert.ok(third)
    assert.notEqual(third, first)
  })

  it('ensureWorktreeRecoverable is true on a clean worktree without taking a backup', async () => {
    assert.equal(await ensureWorktreeRecoverable(), true)
    assert.equal(getSessionBackup(), null)
  })

  it('ensureWorktreeRecoverable backs up a dirty worktree and reports recoverable', async () => {
    await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')
    assert.equal(await ensureWorktreeRecoverable(), true)
    assert.ok(getSessionBackup(), 'a backup should have been taken')
  })

  it('ensureWorktreeRecoverable is false when git is unavailable (no safety net)', async () => {
    await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')
    setGitAvailableForTest(false)
    assert.equal(await ensureWorktreeRecoverable(), false)
  })
})
