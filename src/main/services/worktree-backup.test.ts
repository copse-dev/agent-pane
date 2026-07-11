import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createWorktreeBackup,
  pruneWorktreeBackups,
  restoreWorktreeBackup,
} from './github/git-service.ts'
import {
  ensureSessionBackup,
  ensureWorktreeRecoverable,
  getSessionBackup,
  resetSessionBackup,
  restoreSessionBackup,
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

describe('restoreWorktreeBackup', () => {
  let root = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setGitAvailableForTest(true)
    root = await mkdtemp(join(tmpdir(), 'agent-pane-restore-'))
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

  it('reverts a modified tracked file to its snapshot content', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nMINE\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot')
    assert.ok(ref)

    // The agent overwrites the user's uncommitted edit.
    await writeFile(join(root, 'tracked.txt'), 'AGENT REWROTE EVERYTHING\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt']), true)
    const restored = await readFile(join(root, 'tracked.txt'), 'utf-8')
    assert.equal(restored, 'line1\nMINE\n')
  })

  it('recreates an untracked file the snapshot captured', async () => {
    await writeFile(join(root, 'scratch.txt'), 'user scratch\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot')
    assert.ok(ref)

    // The agent overwrites the brand-new untracked file.
    await writeFile(join(root, 'scratch.txt'), 'clobbered\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['scratch.txt']), true)
    const restored = await readFile(join(root, 'scratch.txt'), 'utf-8')
    assert.equal(restored, 'user scratch\n')
  })

  it('leaves paths outside the list alone', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nMINE\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot')
    assert.ok(ref)
    await writeFile(join(root, 'agent-new.txt'), 'agent work\n', 'utf-8')
    await writeFile(join(root, 'tracked.txt'), 'clobbered\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt']), true)
    const agentFile = await readFile(join(root, 'agent-new.txt'), 'utf-8')
    assert.equal(agentFile, 'agent work\n', 'agent-created file must survive restore')
  })

  it('deletes a captured path the snapshot no longer holds (pre-session deletion)', async () => {
    // User staged a deletion of a tracked file before the agent ran, so the
    // snapshot lacks it; the agent then recreated it as an untracked file.
    git(root, ['rm', '--quiet', 'tracked.txt'])
    const ref = await createWorktreeBackup('snapshot')
    assert.ok(ref)
    await writeFile(join(root, 'tracked.txt'), 'agent recreated\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt']), true)
    const { access } = await import('node:fs/promises')
    await assert.rejects(access(join(root, 'tracked.txt')), 'file should be gone after restore')
  })

  it('is a no-op with an empty path list and false when git is unavailable', async () => {
    assert.equal(await restoreWorktreeBackup('refs/copse/backups/1', []), true)
    setGitAvailableForTest(false)
    assert.equal(await restoreWorktreeBackup('refs/copse/backups/1', ['tracked.txt']), false)
  })
})

describe('pruneWorktreeBackups', () => {
  let root = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setGitAvailableForTest(true)
    root = await mkdtemp(join(tmpdir(), 'agent-pane-prune-'))
    git(root, ['init'])
    git(root, ['commit', '--allow-empty', '-m', 'initial'])
    restoreWorkspace = setWorkspaceRootForTest(root)
  })

  afterEach(async () => {
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  function backupRefs(): string[] {
    return git(root, ['for-each-ref', '--format=%(refname)', 'refs/copse/backups'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }

  it('keeps the newest N refs and deletes the rest', async () => {
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    for (const stamp of [100, 200, 300, 400, 500]) {
      git(root, ['update-ref', `refs/copse/backups/${String(stamp)}`, head])
    }
    assert.equal(backupRefs().length, 5)

    await pruneWorktreeBackups(2)

    const remaining = backupRefs().sort()
    assert.deepEqual(remaining, ['refs/copse/backups/400', 'refs/copse/backups/500'])
  })

  it('does nothing when at or below the retention count', async () => {
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    git(root, ['update-ref', 'refs/copse/backups/1', head])
    await pruneWorktreeBackups(10)
    assert.equal(backupRefs().length, 1)
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

  it('restoreSessionBackup reverts the captured paths to their pre-session content', async () => {
    await writeFile(join(root, 'dirty.txt'), 'user work\n', 'utf-8')
    const backup = await ensureSessionBackup()
    assert.ok(backup)

    // The agent overwrites the user's uncommitted file this session.
    await writeFile(join(root, 'dirty.txt'), 'agent rewrote it\n', 'utf-8')

    assert.equal(await restoreSessionBackup(), true)
    assert.equal(await readFile(join(root, 'dirty.txt'), 'utf-8'), 'user work\n')
  })

  it('restoreSessionBackup returns false when there is no backup', async () => {
    assert.equal(getSessionBackup(), null)
    assert.equal(await restoreSessionBackup(), false)
  })
})
