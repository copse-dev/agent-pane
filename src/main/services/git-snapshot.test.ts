import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  parseWorkingTreeSnapshotHead,
  snapshotWorkingTree,
  type SnapshotGitRunner,
} from './git-snapshot.mts'

const execFileAsync = promisify(execFile)

function runnerFor(cwd: string): SnapshotGitRunner {
  return async (args, env) => {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return stdout.trim()
  }
}

async function repo(): Promise<{ dir: string; git: SnapshotGitRunner }> {
  const dir = mkdtempSync(join(tmpdir(), 'copse-snapshot-'))
  const git = runnerFor(dir)
  await git(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(dir, 'kept.txt'), 'kept\n')
  writeFileSync(join(dir, 'gone.txt'), 'gone\n')
  await git(['add', '-A'])
  await git([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@copse.invalid',
    'commit',
    '--quiet',
    '-m',
    'init',
  ])
  return { dir, git }
}

const IDENTITY = { name: 'snapshot', email: 'snapshot@copse.invalid' }

describe('snapshotWorkingTree', () => {
  it('commits modifications, untracked files and deletions without touching HEAD or the index', async () => {
    const { dir, git } = await repo()
    try {
      const head = await git(['rev-parse', 'HEAD'])
      writeFileSync(join(dir, 'kept.txt'), 'changed\n')
      writeFileSync(join(dir, 'new.txt'), 'brand new\n')
      unlinkSync(join(dir, 'gone.txt'))
      const status = await git(['status', '--porcelain'])
      let headReads = 0
      const trackedGit: SnapshotGitRunner = (args, env) => {
        if (args[0] === 'show' && args.at(-1) === 'HEAD') headReads += 1
        return git(args, env)
      }
      const snapshot = await snapshotWorkingTree(trackedGit, {
        message: 'snap',
        identity: IDENTITY,
      })
      assert.equal(headReads, 1, 'reads the HEAD commit and tree in one Git process')
      assert.equal(snapshot.dirty, true)
      assert.equal(await git(['show', `${snapshot.sha}:kept.txt`]), 'changed')
      assert.equal(await git(['show', `${snapshot.sha}:new.txt`]), 'brand new')
      await assert.rejects(git(['show', `${snapshot.sha}:gone.txt`]))
      assert.equal(await git(['rev-parse', `${snapshot.sha}^`]), head, 'parented on HEAD')
      assert.equal(await git(['rev-parse', 'HEAD']), head, 'HEAD did not move')
      assert.equal(await git(['status', '--porcelain']), status, 'index and tree untouched')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers HEAD itself for a clean tree, and a root commit for a repository with none', async () => {
    const { dir, git } = await repo()
    try {
      const head = await git(['rev-parse', 'HEAD'])
      assert.deepEqual(await snapshotWorkingTree(git, { message: 'snap', identity: IDENTITY }), {
        sha: head,
        dirty: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const fresh = mkdtempSync(join(tmpdir(), 'copse-snapshot-fresh-'))
    try {
      const git = runnerFor(fresh)
      await git(['init', '--quiet', '--initial-branch=main'])
      writeFileSync(join(fresh, 'first.txt'), 'first\n')
      const snapshot = await snapshotWorkingTree(git, { message: 'root', identity: IDENTITY })
      assert.equal(snapshot.dirty, true)
      assert.equal(await git(['show', `${snapshot.sha}:first.txt`]), 'first')
      await assert.rejects(git(['rev-parse', '--verify', `${snapshot.sha}^`]), 'no parent')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('reuses a caller-provided HEAD commit and tree without reading them again', async () => {
    const { dir, git } = await repo()
    try {
      const head = parseWorkingTreeSnapshotHead(
        await git(['show', '-s', '--format=%H%x00%T', 'HEAD']),
      )
      assert.ok(head)
      writeFileSync(join(dir, 'kept.txt'), 'changed\n')
      let headReads = 0
      const trackedGit: SnapshotGitRunner = (args, env) => {
        if (args[0] === 'show' && args.at(-1) === 'HEAD') headReads += 1
        return git(args, env)
      }

      const snapshot = await snapshotWorkingTree(trackedGit, {
        message: 'snap',
        identity: IDENTITY,
        head,
      })

      assert.equal(headReads, 0)
      assert.equal(snapshot.dirty, true)
      assert.equal(await git(['rev-parse', `${snapshot.sha}^`]), head.sha)
      assert.equal(await git(['show', `${snapshot.sha}:kept.txt`]), 'changed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
