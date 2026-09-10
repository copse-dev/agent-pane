import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterSandboxedCommand,
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
  spawnInProjectSandbox,
} from './index.ts'
import {
  clearAllowedWorkspaceRootsForTest,
  registerInternalWorkspaceRoot,
} from '../services/workspace.ts'
import { createWorktreeBackup, getGitStatus } from '../services/github/git-service.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'
import { workspaceTmpDir } from './config.ts'

interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Copse Test',
  GIT_AUTHOR_EMAIL: 'copse@example.invalid',
  GIT_COMMITTER_NAME: 'Copse Test',
  GIT_COMMITTER_EMAIL: 'copse@example.invalid',
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv })
}

async function runSandboxed(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const child = await spawnInProjectSandbox(executable, args, {
    cwd,
    env: gitEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => {
      resolve(exitCode ?? 1)
    })
  })
  afterSandboxedCommand()
  return { stdout, stderr, code }
}

describe('linked-worktree sandbox integration', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    await shutdownProjectSandbox()
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('supports Git from a nested project root without exposing hooks, config, or siblings', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'copse-worktree-sandbox-'))
    cleanups.push(root)
    const repo = join(root, 'repo')
    const worktree = join(root, 'thread')
    const sibling = join(root, 'sibling')
    const nested = join(worktree, 'packages', 'app')
    await mkdir(join(repo, 'packages', 'app'), { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'packages', 'app', 'tracked.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-a', worktree])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-b', sibling])
    // A sibling nested INSIDE the primary checkout (the `.claude/worktrees/`
    // layout): the primary is readable, this must not be.
    const nestedSibling = join(repo, '.worktrees', 'thread-c')
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-c', nestedSibling])
    await writeFile(join(sibling, 'sibling-only.txt'), 'secret\n')
    await writeFile(join(nestedSibling, 'nested-sibling-only.txt'), 'secret\n')

    const registration = await registerInternalWorkspaceRoot(worktree, nested)
    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }

    const status = await runSandboxed('git', ['status', '--short'], nested)
    assert.equal(status.code, 0, status.stderr)
    const productStatus = await getGitStatus(nested)
    assert.deepEqual(productStatus, { staged: [], unstaged: [] })
    await writeFile(join(nested, 'tracked.txt'), 'changed\n')
    await writeFile(join(nested, 'new.txt'), 'new\n')
    assert.match((await runSandboxed('git', ['diff', '--', '.'], nested)).stdout, /changed/)
    const add = await runSandboxed('git', ['add', 'tracked.txt', 'new.txt'], nested)
    assert.equal(add.code, 0, add.stderr)
    const commit = await runSandboxed('git', ['commit', '-q', '-m', 'sandbox commit'], nested)
    assert.equal(commit.code, 0, commit.stderr)

    const configWrite = await runSandboxed('git', ['config', 'copse.sandbox-test', 'true'], nested)
    assert.notEqual(configWrite.code, 0)
    assert.throws(() => git(repo, ['config', '--get', 'copse.sandbox-test']))

    const hookPath = join(registration.commonGitDir, 'hooks', 'pre-commit')
    const writeHook = await runSandboxed(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "blocked")', hookPath],
      nested,
    )
    assert.notEqual(writeHook.code, 0)
    assert.equal(existsSync(hookPath), false)

    const readSibling = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(sibling, 'sibling-only.txt'),
      ],
      nested,
    )
    assert.notEqual(readSibling.code, 0)
    assert.equal(readSibling.stdout, '')

    // The shared primary checkout is readable from a linked worktree — the
    // reconcile-worktrees post-mortem found `git -C <primary> …` dying with
    // "Unable to read current working directory" and `git worktree list`
    // reporting no linked entries — but never writable, and a sibling
    // worktree nested inside it stays unreadable.
    await writeFile(join(repo, 'primary-only.txt'), 'primary secret\n')
    const readPrimary = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(repo, 'primary-only.txt'),
      ],
      nested,
    )
    assert.equal(readPrimary.code, 0, readPrimary.stderr)
    assert.equal(readPrimary.stdout, 'primary secret\n')

    const writePrimary = await runSandboxed(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "tampered")',
        join(repo, 'new.txt'),
      ],
      nested,
    )
    assert.notEqual(writePrimary.code, 0)
    assert.equal(existsSync(join(repo, 'new.txt')), false)
    const overwritePrimary = await runSandboxed(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "tampered")',
        join(repo, 'primary-only.txt'),
      ],
      nested,
    )
    assert.notEqual(overwritePrimary.code, 0)
    assert.equal(await readFile(join(repo, 'primary-only.txt'), 'utf8'), 'primary secret\n')

    const primaryHead = await runSandboxed('git', ['-C', repo, 'rev-parse', 'HEAD'], nested)
    assert.equal(primaryHead.code, 0, primaryHead.stderr)
    assert.match(primaryHead.stdout, /^[0-9a-f]{40}\n$/)
    const primaryStatus = await runSandboxed('git', ['-C', repo, 'status', '--short'], nested)
    assert.equal(primaryStatus.code, 0, primaryStatus.stderr)
    assert.match(primaryStatus.stdout, /primary-only\.txt/)

    // Git prints canonical paths (the tmpdir is symlinked on macOS). Every
    // worktree is listed with a real HEAD — the primary's used to read as
    // 0000000 and the linked ones were missing entirely. Sibling working trees
    // stay unreadable, which git reports as "prunable"; that is the honest
    // answer, not a broken one.
    const worktreeList = await runSandboxed('git', ['worktree', 'list', '--porcelain'], nested)
    assert.equal(worktreeList.code, 0, worktreeList.stderr)
    const listed = worktreeList.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    assert.deepEqual(
      new Set(listed),
      new Set(
        await Promise.all([repo, worktree, sibling, nestedSibling].map((path) => realpath(path))),
      ),
    )
    assert.doesNotMatch(worktreeList.stdout, /HEAD 0{40}/)

    const readNestedSibling = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(nestedSibling, 'nested-sibling-only.txt'),
      ],
      nested,
    )
    assert.notEqual(readNestedSibling.code, 0)
    assert.equal(readNestedSibling.stdout, '')

    // Sibling packages under the same worktree checkout must also be denied
    // when the execution root is nested (packages/app), while the agent's
    // own execution root remains readable via the more-specific allow.
    await mkdir(join(worktree, 'packages', 'other'), { recursive: true })
    await writeFile(join(worktree, 'packages', 'other', 'peer.txt'), 'sibling pkg\n')
    const readSiblingPkg = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(worktree, 'packages', 'other', 'peer.txt'),
      ],
      nested,
    )
    assert.notEqual(readSiblingPkg.code, 0)
    assert.equal(readSiblingPkg.stdout, '')
  })

  it('creates a dirty-worktree backup with its temporary index in sandbox scratch', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'copse-backup-sandbox-'))
    cleanups.push(root)
    const repo = join(root, 'repo')
    const worktree = join(root, 'thread')
    const nested = join(worktree, 'packages', 'app')
    await mkdir(join(repo, 'packages', 'app'), { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'packages', 'app', 'tracked.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-a', worktree])
    const registration = await registerInternalWorkspaceRoot(worktree, nested)

    const previousCopseDir = process.env['COPSE_DIR']
    process.env['COPSE_DIR'] = join(root, 'copse-profile')
    try {
      setGitAvailableForTest(true)
      await initProjectSandbox()
      if (!isProjectSandboxEnabled()) {
        t.skip('ASRT sandbox unavailable')
        return
      }

      const tracked = join(nested, 'tracked.txt')
      const untracked = join(nested, 'untracked.txt')
      await writeFile(tracked, 'staged\n')
      git(worktree, ['add', 'packages/app/tracked.txt'])
      await writeFile(tracked, 'staged and unstaged\n')
      await writeFile(untracked, 'new user file\n')

      const headBefore = git(worktree, ['rev-parse', 'HEAD'])
      const indexBefore = git(worktree, ['ls-files', '--stage'])
      const indexBytesBefore = await readFile(join(registration.gitDir, 'index'))
      const statusBefore = git(worktree, ['status', '--porcelain=v1'])
      const backup = await createWorktreeBackup('sandbox checkpoint', nested)
      assert.ok(backup, 'expected a backup ref')

      assert.equal(git(worktree, ['rev-parse', 'HEAD']), headBefore)
      assert.equal(git(worktree, ['ls-files', '--stage']), indexBefore)
      assert.deepEqual(await readFile(join(registration.gitDir, 'index')), indexBytesBefore)
      assert.equal(git(worktree, ['status', '--porcelain=v1']), statusBefore)
      assert.equal(
        git(worktree, ['show', `${backup}:packages/app/tracked.txt`]),
        'staged and unstaged\n',
      )
      assert.equal(
        git(worktree, ['show', `${backup}:packages/app/untracked.txt`]),
        'new user file\n',
      )
      assert.doesNotMatch(git(worktree, ['ls-tree', '-r', '--name-only', backup]), /copse-backup-/)

      const scratchEntries = await readdir(workspaceTmpDir())
      assert.equal(
        scratchEntries.some((entry) => entry.startsWith('copse-backup-')),
        false,
        'temporary index directory should be cleaned up',
      )
    } finally {
      if (previousCopseDir === undefined) delete process.env['COPSE_DIR']
      else process.env['COPSE_DIR'] = previousCopseDir
    }
  })
})
