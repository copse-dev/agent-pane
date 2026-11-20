import { configureThreadStore } from '@copse/thread-store/environment.ts'
let isolatedBackupStore = ''
before(async () => {
  isolatedBackupStore = await mkdtemp(join(tmpdir(), 'copse-backup-store-'))
  configureThreadStore({ workspaceRoot: () => isolatedBackupStore })
})
after(async () => {
  configureThreadStore()
  if (isolatedBackupStore) await rm(isolatedBackupStore, { recursive: true, force: true })
})

import { before, after, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createWorktreeBackup,
  pruneWorktreeBackups,
  restoreWorktreeBackup,
} from './github/git-service.ts'
import {
  clearSessionBackupsForTest,
  ensureSessionBackup,
  ensureWorktreeRecoverable,
  getSessionBackup,
  getRestorableSessionBackup,
  resetSessionBackup,
  restoreSessionBackup,
} from './worktree-backup.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { ownedIt, TEST_THREAD_OWNER } from './thread-execution-context.test-support.ts'

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

  ownedIt(
    'captures modified tracked AND untracked files without touching the worktree',
    async () => {
      await writeFile(join(root, 'tracked.txt'), 'line1\nCHANGED\n', 'utf-8')
      await writeFile(join(root, 'untracked.txt'), 'brand new\n', 'utf-8')
      const statusBefore = git(root, ['status', '--porcelain'])

      const ref = await createWorktreeBackup('test snapshot', root)
      assert.ok(ref, 'expected a backup ref')
      assert.match(ref, /^refs\/copse\/backups\//)

      // The snapshot commit holds both the modified tracked file and the untracked one.
      assert.equal(git(root, ['show', `${ref}:tracked.txt`]), 'line1\nCHANGED\n')
      assert.equal(git(root, ['show', `${ref}:untracked.txt`]), 'brand new\n')

      // The working tree and index are unchanged — the backup is a side snapshot.
      assert.equal(git(root, ['status', '--porcelain']), statusBefore)
    },
  )

  ownedIt('returns null when git is unavailable', async () => {
    setGitAvailableForTest(false)
    assert.equal(await createWorktreeBackup('x', root), null)
  })

  ownedIt('reports Git failure without leaking stderr or leaving scratch', async () => {
    await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')
    await writeFile(join(root, '.gitattributes'), 'dirty.txt filter=copse-test\n', 'utf-8')
    git(root, ['add', '.gitattributes'])
    git(root, ['commit', '-m', 'attributes'])
    git(root, ['config', 'filter.copse-test.clean', "sh -c 'echo SECRET_SENTINEL >&2; exit 1'"])
    git(root, ['config', 'filter.copse-test.required', 'true'])
    const previousTmpDir = process.env['TMPDIR']
    const previousTmp = process.env['TMP']
    const previousTemp = process.env['TEMP']
    const indexScratch = await mkdtemp(join(tmpdir(), 'agent-pane-backup-index-'))
    process.env['TMPDIR'] = indexScratch
    process.env['TMP'] = indexScratch
    process.env['TEMP'] = indexScratch
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...values: unknown[]): void => {
      warnings.push(values.map((value) => String(value)).join(' '))
    }
    try {
      assert.equal(await createWorktreeBackup('SECRET_SENTINEL', root), null)
      const after = await readdir(indexScratch)
      assert.equal(
        after.some((entry) => entry.startsWith('copse-backup-')),
        false,
        'temporary index directory should be cleaned up',
      )
      assert.equal(
        warnings.some((warning) => warning.includes('SECRET_SENTINEL')),
        false,
      )
      assert.match(warnings[0] ?? '', /\[git-backup\] checkpoint failed at add \(\d+\)/)
    } finally {
      console.warn = originalWarn
      if (previousTmpDir === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previousTmpDir
      if (previousTmp === undefined) delete process.env['TMP']
      else process.env['TMP'] = previousTmp
      if (previousTemp === undefined) delete process.env['TEMP']
      else process.env['TEMP'] = previousTemp
      await rm(indexScratch, { recursive: true, force: true })
    }
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

  ownedIt('reverts a modified tracked file to its snapshot content', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nMINE\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot', root)
    assert.ok(ref)

    // The agent overwrites the user's uncommitted edit.
    await writeFile(join(root, 'tracked.txt'), 'AGENT REWROTE EVERYTHING\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt'], root), true)
    const restored = await readFile(join(root, 'tracked.txt'), 'utf-8')
    assert.equal(restored, 'line1\nMINE\n')
  })

  ownedIt('recreates an untracked file the snapshot captured', async () => {
    await writeFile(join(root, 'scratch.txt'), 'user scratch\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot', root)
    assert.ok(ref)

    // The agent overwrites the brand-new untracked file.
    await writeFile(join(root, 'scratch.txt'), 'clobbered\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['scratch.txt'], root), true)
    const restored = await readFile(join(root, 'scratch.txt'), 'utf-8')
    assert.equal(restored, 'user scratch\n')
  })

  ownedIt('leaves paths outside the list alone', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nMINE\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot', root)
    assert.ok(ref)
    await writeFile(join(root, 'agent-new.txt'), 'agent work\n', 'utf-8')
    await writeFile(join(root, 'tracked.txt'), 'clobbered\n', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt'], root), true)
    const agentFile = await readFile(join(root, 'agent-new.txt'), 'utf-8')
    assert.equal(agentFile, 'agent work\n', 'agent-created file must survive restore')
  })

  ownedIt(
    'deletes a captured path the snapshot no longer holds (pre-session deletion)',
    async () => {
      // User staged a deletion of a tracked file before the agent ran, so the
      // snapshot lacks it; the agent then recreated it as an untracked file.
      git(root, ['rm', '--quiet', 'tracked.txt'])
      const ref = await createWorktreeBackup('snapshot', root)
      assert.ok(ref)
      await writeFile(join(root, 'tracked.txt'), 'agent recreated\n', 'utf-8')

      assert.equal(await restoreWorktreeBackup(ref, ['tracked.txt'], root), true)
      const { access } = await import('node:fs/promises')
      await assert.rejects(access(join(root, 'tracked.txt')), 'file should be gone after restore')
    },
  )

  ownedIt('keeps dirty files and reports failure when the snapshot ref is missing', async () => {
    await writeFile(join(root, 'tracked.txt'), 'line1\nMINE\n', 'utf-8')
    await writeFile(join(root, 'untracked.txt'), 'user work\n', 'utf-8')

    // The ref was pruned (or never written): nothing may be deleted.
    assert.equal(
      await restoreWorktreeBackup('refs/copse/backups/1', ['tracked.txt', 'untracked.txt'], root),
      false,
    )
    assert.equal(await readFile(join(root, 'tracked.txt'), 'utf-8'), 'line1\nMINE\n')
    assert.equal(await readFile(join(root, 'untracked.txt'), 'utf-8'), 'user work\n')
  })

  ownedIt('keeps a snapshotted file when git restore fails for another reason', async () => {
    await writeFile(join(root, 'scratch.txt'), 'user scratch\n', 'utf-8')
    const ref = await createWorktreeBackup('snapshot', root)
    assert.ok(ref)
    await writeFile(join(root, 'scratch.txt'), 'clobbered\n', 'utf-8')
    // A held index lock makes `git restore` exit 128 even though the snapshot
    // holds the path.
    await writeFile(join(root, '.git', 'index.lock'), '', 'utf-8')

    assert.equal(await restoreWorktreeBackup(ref, ['scratch.txt'], root), false)
    assert.equal(await readFile(join(root, 'scratch.txt'), 'utf-8'), 'clobbered\n')
  })

  ownedIt('is a no-op with an empty path list and false when git is unavailable', async () => {
    assert.equal(await restoreWorktreeBackup('refs/copse/backups/1', [], root), true)
    setGitAvailableForTest(false)
    assert.equal(await restoreWorktreeBackup('refs/copse/backups/1', ['tracked.txt'], root), false)
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

  ownedIt('keeps the newest N refs and deletes the rest', async () => {
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    for (const stamp of [100, 200, 300, 400, 500]) {
      git(root, ['update-ref', `refs/copse/backups/${String(stamp)}`, head])
    }
    assert.equal(backupRefs().length, 5)

    await pruneWorktreeBackups(2, root)

    const remaining = backupRefs().sort()
    assert.deepEqual(remaining, ['refs/copse/backups/400', 'refs/copse/backups/500'])
  })

  ownedIt('does nothing when at or below the retention count', async () => {
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    git(root, ['update-ref', 'refs/copse/backups/1', head])
    await pruneWorktreeBackups(10, root)
    assert.equal(backupRefs().length, 1)
  })
})

describe('ensureSessionBackup / resetSessionBackup', () => {
  let root = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    resetSessionBackup(TEST_THREAD_OWNER)
    setGitAvailableForTest(true)
    root = await mkdtemp(join(tmpdir(), 'agent-pane-session-backup-'))
    git(root, ['init'])
    git(root, ['commit', '--allow-empty', '-m', 'initial'])
    restoreWorkspace = setWorkspaceRootForTest(root)
  })

  afterEach(async () => {
    resetSessionBackup(TEST_THREAD_OWNER)
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  ownedIt('returns null on a clean worktree (nothing to protect)', async () => {
    assert.equal(await ensureSessionBackup(root), null)
    assert.equal(getSessionBackup(), null)
  })

  ownedIt('takes one backup for a dirty worktree and reuses it until reset', async () => {
    await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')

    const first = await ensureSessionBackup(root)
    assert.ok(first, 'expected a backup')
    assert.match(first.ref, /^refs\/copse\/backups\//)
    assert.deepEqual(first.paths, ['dirty.txt'])

    // Idempotent within a turn: the same restore point is reused, not re-taken.
    const second = await ensureSessionBackup(root)
    assert.equal(second, first)
    assert.equal(getSessionBackup(), first)

    // A new turn resets the restore point; the next ensure snapshots afresh.
    resetSessionBackup(TEST_THREAD_OWNER)
    assert.equal(
      getSessionBackup(),
      first,
      'a read-only follow-up must keep the previous restore point',
    )
    const third = await ensureSessionBackup(root)
    assert.ok(third)
    assert.notEqual(third, first)
  })

  ownedIt(
    'ensureWorktreeRecoverable is true on a clean worktree without taking a backup',
    async () => {
      assert.equal(await ensureWorktreeRecoverable(root), true)
      assert.equal(getSessionBackup(), null)
    },
  )

  ownedIt(
    'ensureWorktreeRecoverable backs up a dirty worktree and reports recoverable',
    async () => {
      await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')
      assert.equal(await ensureWorktreeRecoverable(root), true)
      assert.ok(getSessionBackup(), 'a backup should have been taken')
    },
  )

  ownedIt('rechecks new user work after an earlier clean approval in the same turn', async () => {
    assert.equal(await ensureWorktreeRecoverable(root), true)
    assert.equal(getSessionBackup(), null)
    await writeFile(join(root, 'new-user-draft.txt'), 'manual work during the turn\n', 'utf8')
    assert.equal(await ensureWorktreeRecoverable(root), true)
    assert.ok(getSessionBackup()?.paths.includes('new-user-draft.txt'))
    await writeFile(join(root, 'new-user-draft.txt'), 'later agent edit\n', 'utf8')
    assert.equal(await restoreSessionBackup(), true)
    assert.equal(
      await readFile(join(root, 'new-user-draft.txt'), 'utf8'),
      'manual work during the turn\n',
    )
  })

  ownedIt(
    'does not reuse a clean approval when Git can no longer verify recoverability',
    async () => {
      assert.equal(await ensureWorktreeRecoverable(root), true)
      setGitAvailableForTest(false)
      assert.equal(await ensureWorktreeRecoverable(root), false)
    },
  )

  ownedIt(
    'ensureWorktreeRecoverable is false when git is unavailable (no safety net)',
    async () => {
      await writeFile(join(root, 'dirty.txt'), 'work\n', 'utf-8')
      setGitAvailableForTest(false)
      assert.equal(await ensureWorktreeRecoverable(root), false)
    },
  )

  ownedIt(
    'restoreSessionBackup reverts the captured paths to their pre-session content',
    async () => {
      await writeFile(join(root, 'dirty.txt'), 'user work\n', 'utf-8')
      const backup = await ensureSessionBackup(root)
      assert.ok(backup)

      // The agent overwrites the user's uncommitted file this session.
      await writeFile(join(root, 'dirty.txt'), 'agent rewrote it\n', 'utf-8')

      assert.equal(await restoreSessionBackup(), true)
      assert.equal(await readFile(join(root, 'dirty.txt'), 'utf-8'), 'user work\n')
    },
  )

  ownedIt('loads the same checkout restore point after process state is lost', async () => {
    await writeFile(join(root, 'dirty.txt'), 'user checkpoint\n')
    const backup = await ensureSessionBackup(root)
    assert.ok(backup)
    await writeFile(join(root, 'dirty.txt'), 'agent edit\n')
    clearSessionBackupsForTest()
    assert.deepEqual(getSessionBackup(), backup)
    assert.equal(await restoreSessionBackup(), true)
    assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'user checkpoint\n')
  })

  ownedIt('never restores a stored checkpoint into another checkout', async () => {
    await writeFile(join(root, 'dirty.txt'), 'user checkpoint\n')
    assert.ok(await ensureSessionBackup(root))
    clearSessionBackupsForTest()
    assert.equal(getSessionBackup(TEST_THREAD_OWNER, join(root, 'other')), null)
    assert.equal(await restoreSessionBackup(TEST_THREAD_OWNER, join(root, 'other')), false)
    assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'user checkpoint\n')
  })

  ownedIt(
    'retires a pruned restore point after restart without touching current work',
    async () => {
      await writeFile(join(root, 'dirty.txt'), 'user draft\n')
      const backup = await ensureSessionBackup(root)
      assert.ok(backup)
      const head = git(root, ['rev-parse', 'HEAD']).trim()
      for (let index = 1; index <= 11; index++)
        git(root, ['update-ref', `refs/copse/backups/${String(backup.createdAt + index)}`, head])
      await pruneWorktreeBackups(10, root)
      await writeFile(join(root, 'dirty.txt'), 'current work\n')
      clearSessionBackupsForTest()
      assert.equal(await getRestorableSessionBackup(), null)
      assert.equal(await restoreSessionBackup(), false)
      clearSessionBackupsForTest()
      assert.equal(getSessionBackup(), null, 'expired binding must stay retired after restart')
      assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'current work\n')
    },
  )

  for (const restart of [false, true]) {
    ownedIt(
      `retires a point behind a new commit${restart ? ' after restart' : ' after it was offered'}`,
      async () => {
        await writeFile(join(root, 'dirty.txt'), 'user draft\n')
        assert.ok(await ensureSessionBackup(root))
        assert.ok(await getRestorableSessionBackup())
        await writeFile(join(root, 'dirty.txt'), 'committed repair\n')
        git(root, ['add', '-A'])
        git(root, ['commit', '-m', 'keep repair'])
        const index = git(root, ['ls-files', '--stage'])
        if (restart) clearSessionBackupsForTest()
        assert.equal(await restoreSessionBackup(), false)
        assert.equal(await getRestorableSessionBackup(), null)
        clearSessionBackupsForTest()
        assert.equal(getSessionBackup(), null)
        assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'committed repair\n')
        assert.equal(git(root, ['ls-files', '--stage']), index)
      },
    )
  }

  ownedIt(
    'keeps an index-only point at HEAD but retires it after checking out its parent',
    async () => {
      await writeFile(join(root, 'tracked.txt'), 'baseline\n')
      git(root, ['add', '-A'])
      git(root, ['commit', '-m', 'tracked baseline'])
      await writeFile(join(root, 'tracked.txt'), 'staged user work\n')
      git(root, ['add', 'tracked.txt'])
      await writeFile(join(root, 'tracked.txt'), 'baseline\n')
      const index = git(root, ['ls-files', '--stage'])
      const backup = await ensureSessionBackup(root)
      assert.ok(backup)
      assert.equal(git(root, ['rev-parse', backup.ref]), git(root, ['rev-parse', 'HEAD']))
      clearSessionBackupsForTest()
      assert.deepEqual(await getRestorableSessionBackup(), backup)
      await writeFile(join(root, 'tracked.txt'), 'agent edit\n')
      assert.equal(await restoreSessionBackup(), true)
      assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'baseline\n')
      assert.equal(git(root, ['ls-files', '--stage']), index)
      git(root, ['reset', '--soft', 'HEAD^'])
      assert.equal(await getRestorableSessionBackup(), null)
    },
  )

  ownedIt('restores an unborn checkout until its first real commit', async () => {
    git(root, ['update-ref', '-d', 'HEAD'])
    await writeFile(join(root, 'dirty.txt'), 'first user draft\n')
    const backup = await ensureSessionBackup(root)
    assert.ok(backup)
    clearSessionBackupsForTest()
    assert.deepEqual(await getRestorableSessionBackup(), backup)
    await writeFile(join(root, 'dirty.txt'), 'agent edit\n')
    assert.equal(await restoreSessionBackup(), true)
    assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'first user draft\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'first real commit'])
    assert.equal(await getRestorableSessionBackup(), null)
  })

  ownedIt('preserves its binding when Git is temporarily unavailable', async () => {
    await writeFile(join(root, 'dirty.txt'), 'user draft\n')
    const backup = await ensureSessionBackup(root)
    assert.ok(backup)
    clearSessionBackupsForTest()
    setGitAvailableForTest(false)
    assert.equal(await getRestorableSessionBackup(), null)
    assert.equal(await restoreSessionBackup(), false)
    setGitAvailableForTest(true)
    clearSessionBackupsForTest()
    assert.deepEqual(await getRestorableSessionBackup(), backup)
  })

  ownedIt(
    'refuses restore when its safety snapshot fails, preserving files and index',
    async () => {
      await writeFile(join(root, 'dirty.txt'), 'user draft\n')
      const backup = await ensureSessionBackup(root)
      assert.ok(backup)
      await writeFile(join(root, 'dirty.txt'), 'current agent work\n')
      git(root, ['add', 'dirty.txt'])
      await writeFile(join(root, 'new.txt'), 'new user work\n')
      await writeFile(join(root, '.gitattributes'), 'dirty.txt filter=fail-snapshot\n')
      git(root, ['config', 'filter.fail-snapshot.clean', 'false'])
      git(root, ['config', 'filter.fail-snapshot.required', 'true'])
      const index = git(root, ['ls-files', '--stage'])
      assert.equal(await restoreSessionBackup(), false)
      assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'current agent work\n')
      assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new user work\n')
      assert.equal(git(root, ['ls-files', '--stage']), index)
      assert.deepEqual(await getRestorableSessionBackup(), backup)
    },
  )

  ownedIt('preserves an index-only binding while HEAD cannot be resolved', async () => {
    await writeFile(join(root, 'tracked.txt'), 'baseline\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'tracked baseline'])
    await writeFile(join(root, 'tracked.txt'), 'staged work\n')
    git(root, ['add', 'tracked.txt'])
    await writeFile(join(root, 'tracked.txt'), 'baseline\n')
    const backup = await ensureSessionBackup(root)
    assert.ok(backup)
    const branchPath = join(root, '.git', git(root, ['symbolic-ref', 'HEAD']).trim())
    const branch = await readFile(branchPath, 'utf8')
    await writeFile(branchPath, 'unreadable commit id\n')
    try {
      assert.equal(await getRestorableSessionBackup(), null)
      assert.equal(await restoreSessionBackup(), false)
    } finally {
      await writeFile(branchPath, branch)
    }
    clearSessionBackupsForTest()
    assert.deepEqual(await getRestorableSessionBackup(), backup)
  })

  ownedIt('restoreSessionBackup returns false when there is no backup', async () => {
    assert.equal(getSessionBackup(), null)
    assert.equal(await restoreSessionBackup(), false)
  })
})
