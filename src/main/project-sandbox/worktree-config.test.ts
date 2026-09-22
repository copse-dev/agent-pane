import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { worktreeManagerSandboxOverlay, worktreeReadOnlySandboxOverlay } from './worktree-config.ts'
import { initProjectSandbox, isProjectSandboxEnabled, shutdownProjectSandbox } from './index.ts'
import {
  allocateThreadWorktree,
  retireThreadWorktree,
  runWorktreeGit,
} from '../services/worktree-manager.ts'
import { clearAllowedWorkspaceRootsForTest } from '../services/workspace.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'
import { runCommand } from '../services/exec/command-runner.ts'

describe('worktree manager sandbox', () => {
  const cleanups: string[] = []
  const originalWorktrees = process.env['COPSE_WORKTREES_DIR']

  afterEach(async () => {
    await shutdownProjectSandbox()
    clearAllowedWorkspaceRootsForTest()
    setGitAvailableForTest(null)
    if (originalWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = originalWorktrees
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  async function fixture(): Promise<{ temp: string; repo: string }> {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-manager-sandbox-')))
    cleanups.push(temp)
    const repo = join(temp, 'repo')
    await mkdir(repo)
    const git = (args: string[]): void => {
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
        {
          cwd: repo,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Copse Test',
            GIT_AUTHOR_EMAIL: 'copse@example.invalid',
            GIT_COMMITTER_NAME: 'Copse Test',
            GIT_COMMITTER_EMAIL: 'copse@example.invalid',
          },
          stdio: 'pipe',
        },
      )
    }
    git(['init', '-q', '-b', 'main'])
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repo, 'tracked.txt'), 'initial\n')
    git(['add', '.gitignore', 'tracked.txt'])
    git(['commit', '-q', '-m', 'initial'])
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)
    return { temp, repo }
  }

  it('grants the selected destination, never its parent or network, and protects Git config', async () => {
    const { temp, repo } = await fixture()
    const destination = join(temp, 'worktrees', 'project', 'thread')
    const policy = await worktreeManagerSandboxOverlay(repo, [destination])
    const { network, filesystem } = policy
    assert.ok(network)
    assert.ok(filesystem)
    assert.deepEqual(network.allowedDomains, [])
    assert.equal(network.allowLocalBinding, false)
    assert.ok(filesystem.allowWrite.includes(destination))
    assert.ok(filesystem.allowWrite.includes(join(repo, '.git', 'packed-refs.lock')))
    assert.ok(filesystem.allowWrite.includes(join(repo, '.git', 'packed-refs.new')))
    assert.ok(!filesystem.allowWrite.includes(dirname(destination)))
    assert.ok(filesystem.denyWrite.includes(join(repo, '.git', 'config')))
    assert.ok(filesystem.denyWrite.includes(join(repo, '.git', 'hooks')))
  })

  it('allows an authorized atomic config replacement without binding the config file itself', async () => {
    const { repo } = await fixture()
    const policy = await worktreeManagerSandboxOverlay(repo, [], true)
    const filesystem = policy.filesystem
    assert.ok(filesystem)
    assert.ok(filesystem.allowWrite.includes(join(repo, '.git')))
    assert.ok(!filesystem.allowWrite.includes(join(repo, '.git', 'config')))
    assert.ok(!filesystem.allowWrite.includes(join(repo, '.git', 'config.lock')))
    assert.ok(!filesystem.denyWrite.includes(join(repo, '.git', 'config')))
    assert.ok(filesystem.denyWrite.includes(join(repo, '.git', 'config.worktree')))
    assert.ok(filesystem.denyWrite.includes(join(repo, '.git', 'hooks')))
  })

  it('keeps snapshot verification read-only except for its temporary index', async () => {
    const { temp, repo } = await fixture()
    const temporaryIndex = join(temp, 'verification-index')
    await mkdir(temporaryIndex)
    const policy = await worktreeReadOnlySandboxOverlay(repo, [temporaryIndex])
    const filesystem = policy.filesystem
    assert.ok(filesystem)
    assert.deepEqual(filesystem.allowWrite, [temporaryIndex])
    assert.deepEqual(filesystem.denyWrite, [])
    assert.ok(filesystem.allowRead?.includes(join(repo, '.git')))
  })

  it('rejects metadata symlinks instead of granting access to their targets', async () => {
    const { temp, repo } = await fixture()
    const outside = join(temp, 'outside-objects')
    await rename(join(repo, '.git', 'objects'), outside)
    await symlink(outside, join(repo, '.git', 'objects'))
    await assert.rejects(
      () => worktreeManagerSandboxOverlay(repo),
      /metadata write path is redirected/,
    )
  })

  it('refuses a checkout grant if its destination is redirected after manager validation', async () => {
    const { temp, repo } = await fixture()
    const outside = join(temp, 'outside')
    const destination = join(temp, 'redirected')
    await mkdir(outside)
    await symlink(outside, destination)
    await assert.rejects(
      () => worktreeManagerSandboxOverlay(repo, [destination]),
      /destination is redirected/,
    )
  })

  it('creates, renames, and retires worktrees while denying writes outside the sandbox scope', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }
    const { temp, repo } = await fixture()
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }
    let worktree = await allocateThreadWorktree({
      projectId: 'project',
      threadId: 'thread',
      projectRoot: repo,
      prompt: 'Scoped worktree',
      baseBranch: 'main',
    })
    assert.ok(existsSync(join(worktree.path, 'tracked.txt')))
    mkdirSync(join(worktree.path, 'node_modules'))
    const head = await runWorktreeGit(worktree.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    assert.equal(head.code, 0, head.stderr)
    assert.equal(head.stdout.trim(), worktree.branch)
    const renamedBranch = 'copse/renamed-thread'
    const renamed = await runWorktreeGit(worktree.path, ['branch', '-m', renamedBranch])
    assert.equal(renamed.code, 0, renamed.stderr)
    worktree = { ...worktree, branch: renamedBranch }
    const renamedHead = await runWorktreeGit(worktree.path, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
    assert.equal(renamedHead.code, 0, renamedHead.stderr)
    assert.equal(renamedHead.stdout.trim(), renamedBranch)
    const ignored = await runWorktreeGit(worktree.path, [
      'check-ignore',
      '--quiet',
      '--',
      'node_modules',
    ])
    assert.equal(ignored.code, 0, ignored.stderr)
    await rm(join(worktree.path, 'node_modules'), { recursive: true })
    const policy = await worktreeManagerSandboxOverlay(repo, [worktree.path])
    const marker = join(temp, 'outside-marker')
    const probe = await runCommand(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "blocked")', marker],
      { cwd: repo, sandboxConfig: policy },
    )
    assert.notEqual(probe.code, 0)
    assert.equal(existsSync(marker), false)
    const retired = await retireThreadWorktree({
      projectId: 'project',
      threadId: 'thread',
      projectRoot: repo,
      worktree,
    })
    assert.equal(retired.status, 'removed')

    // Dirty seeding uses a temporary index and accesses both checkouts. This
    // must work while containment is active, not only in no-sandbox unit tests.
    await writeFile(join(repo, 'tracked.txt'), 'dirty content\n')
    const seeded = await allocateThreadWorktree({
      projectId: 'project',
      threadId: 'dirty-thread',
      projectRoot: repo,
      prompt: 'Keep dirty content',
      baseBranch: 'main',
    })
    assert.equal(seeded.seededFromDirtyProject, true)
    assert.equal(await readFile(join(seeded.path, 'tracked.txt'), 'utf8'), 'dirty content\n')
  })
})
