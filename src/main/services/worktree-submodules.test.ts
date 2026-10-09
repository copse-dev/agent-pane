import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import {
  allocateThreadWorktree,
  archiveThreadWorktree,
  pruneSafeOrphans,
  removeRegisteredWorktreeCheckout,
  retireThreadWorktree,
  type ValidateWorktreeInput,
} from './worktree-manager.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  }).trim()
}

async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', message])
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

describe('thread worktree submodules', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousRoot
    previousRoot = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  /**
   * A project with an initialised submodule (itself holding a nested one) and
   * a declared submodule the project never initialised. The upstreams are
   * moved away afterwards, so anything that populates must do so offline.
   */
  async function setup(): Promise<{ temp: string; repo: string; libUpstream: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-worktree-submodules-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)

    const upstreams = join(temp, 'upstreams')
    const nested = join(upstreams, 'nested')
    const lib = join(upstreams, 'lib')
    const optional = join(upstreams, 'optional')
    for (const path of [nested, lib, optional]) {
      await mkdir(path, { recursive: true })
      git(path, ['init', '-q', '-b', 'main'])
    }
    await commitFiles(nested, { 'nested.txt': 'nested\n' }, 'nested')
    await commitFiles(lib, { 'lib.txt': 'lib\n', '.gitignore': 'build/\n' }, 'lib')
    git(lib, ['submodule', 'add', '-q', nested, 'deps/nested'])
    git(lib, ['commit', '-q', '-m', 'nest'])
    await commitFiles(optional, { 'optional.txt': 'optional\n' }, 'optional')

    const repo = join(temp, 'repo')
    await mkdir(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    await commitFiles(repo, { 'README.md': 'base\n' }, 'initial')
    git(repo, ['submodule', 'add', '-q', lib, 'vendor/lib'])
    git(repo, ['submodule', 'add', '-q', optional, 'vendor/optional'])
    git(repo, ['commit', '-q', '-m', 'submodules'])
    git(repo, ['submodule', 'update', '-q', '--init', '--recursive'])
    git(repo, ['submodule', 'deinit', '-q', '-f', 'vendor/optional'])
    await rm(join(repo, '.git', 'modules', 'vendor', 'optional'), { recursive: true })

    const moved = join(temp, 'upstreams-offline')
    await rename(upstreams, moved)
    cleanups.push(moved)
    return { temp, repo, libUpstream: lib }
  }

  async function allocate(repo: string, threadId = 'thread-1'): Promise<ThreadWorktree> {
    return allocateThreadWorktree({
      projectId: 'project-1',
      threadId,
      projectRoot: repo,
      prompt: 'Work in a submodule',
      baseBranch: 'main',
    })
  }

  function input(
    repo: string,
    worktree: ThreadWorktree,
    threadId = 'thread-1',
  ): ValidateWorktreeInput {
    return { projectId: 'project-1', threadId, projectRoot: repo, worktree }
  }

  it('populates initialised submodules offline and retires the checkout cleanly', async () => {
    const { repo, libUpstream } = await setup()
    const projectSubmoduleHead = git(join(repo, 'vendor', 'lib'), ['rev-parse', 'HEAD'])
    const worktree = await allocate(repo)
    const lib = join(worktree.path, 'vendor', 'lib')

    assert.equal(await readFile(join(lib, 'lib.txt'), 'utf8'), 'lib\n')
    assert.equal(await readFile(join(lib, 'deps', 'nested', 'nested.txt'), 'utf8'), 'nested\n')
    assert.equal(git(lib, ['rev-parse', 'HEAD']), projectSubmoduleHead)
    // The thread's clone lives in its own administration directory and points
    // at the project's upstream, not at the module repository it came from.
    assert.match(await readFile(join(lib, '.git'), 'utf8'), /[/\\]worktrees[/\\]/)
    assert.equal(git(lib, ['remote', 'get-url', 'origin']), libUpstream)
    // A submodule the project never initialised is not fetched.
    assert.deepEqual(await readdir(join(worktree.path, 'vendor', 'optional')), [])
    assert.equal(git(worktree.path, ['status', '--porcelain', '--ignore-submodules=none']), '')

    assert.deepEqual(await retireThreadWorktree(input(repo, worktree)), {
      status: 'removed',
      branch: worktree.branch,
    })
    assert.equal(await exists(worktree.path), false)
    assert.equal(git(join(repo, 'vendor', 'lib'), ['rev-parse', 'HEAD']), projectSubmoduleHead)
    assert.equal(git(repo, ['status', '--porcelain', '--ignore-submodules=none']), '')
  })

  it('keeps a checkout whose submodule holds a commit nothing else has', async () => {
    const { repo } = await setup()
    const worktree = await allocate(repo)
    const lib = join(worktree.path, 'vendor', 'lib')
    const base = git(lib, ['rev-parse', 'HEAD'])
    git(lib, ['switch', '-q', '-c', 'work'])
    await commitFiles(lib, { 'lib.txt': 'changed\n' }, 'thread work')
    // Back on the recorded commit, so the superproject itself looks clean.
    git(lib, ['switch', '-q', '--detach', base])
    assert.equal(git(worktree.path, ['status', '--porcelain', '--ignore-submodules=none']), '')

    assert.deepEqual(await retireThreadWorktree(input(repo, worktree)), {
      status: 'blocked-dirty',
      paths: ['vendor/lib'],
    })
    assert.deepEqual(
      await pruneSafeOrphans({
        projectId: 'project-1',
        projectRoot: repo,
        baseBranch: 'main',
        knownThreadIds: new Set(),
      }),
      {
        pruned: [],
        retained: [
          {
            threadId: 'thread-1',
            path: worktree.path,
            branch: worktree.branch,
            reason: 'dirty',
            paths: ['vendor/lib'],
          },
        ],
      },
    )

    // Once upstream holds it (as a push records it), nothing is lost.
    git(lib, ['update-ref', 'refs/remotes/origin/work', 'work'])
    assert.equal((await retireThreadWorktree(input(repo, worktree))).status, 'removed')
  })

  it('retains ignored files inside a submodule unless told they are disposable', async () => {
    const { repo } = await setup()
    const worktree = await allocate(repo)
    await mkdir(join(worktree.path, 'vendor', 'lib', 'build'))
    await writeFile(join(worktree.path, 'vendor', 'lib', 'build', 'out.txt'), 'output\n')

    assert.deepEqual(await retireThreadWorktree(input(repo, worktree)), {
      status: 'blocked-dirty',
      paths: ['vendor/lib/build/'],
    })
    assert.equal(
      (await retireThreadWorktree(input(repo, worktree), { ignoreIgnoredFiles: true })).status,
      'removed',
    )
  })

  it('seeds a submodule the project has moved at the project commit', async () => {
    const { repo } = await setup()
    const projectLib = join(repo, 'vendor', 'lib')
    await commitFiles(projectLib, { 'lib.txt': 'moved\n' }, 'moved in the project')
    const moved = git(projectLib, ['rev-parse', 'HEAD'])

    const worktree = await allocate(repo)
    const lib = join(worktree.path, 'vendor', 'lib')
    assert.equal(worktree.seededFromDirtyProject, true)
    assert.equal(git(lib, ['rev-parse', 'HEAD']), moved)
    assert.equal(await readFile(join(lib, 'lib.txt'), 'utf8'), 'moved\n')
    assert.equal(git(worktree.path, ['status', '--porcelain']), 'M vendor/lib')
  })

  it('removes a clean checkout only after git’s own clean check, then forces past submodules', async () => {
    const { repo } = await setup()
    const worktree = await allocate(repo)
    await writeFile(join(worktree.path, 'untracked.txt'), 'work\n')

    assert.notEqual((await removeRegisteredWorktreeCheckout(repo, worktree.path)).code, 0)
    assert.equal(await exists(join(worktree.path, 'untracked.txt')), true)

    await rm(join(worktree.path, 'untracked.txt'))
    assert.equal((await removeRegisteredWorktreeCheckout(repo, worktree.path)).code, 0)
    assert.equal(await exists(worktree.path), false)
  })

  it('never forces past a repository the thread embedded itself', async () => {
    const { repo } = await setup()
    const worktree = await allocate(repo)
    // A clone the agent made and committed as a gitlink: its history lives in
    // its own `.git` directory, which no retention check has looked at.
    const own = join(worktree.path, 'vendor', 'own')
    await mkdir(own)
    git(own, ['init', '-q', '-b', 'main'])
    await commitFiles(own, { 'own.txt': 'only here\n' }, 'embedded')
    git(worktree.path, ['add', 'vendor/own'])
    git(worktree.path, ['commit', '-q', '-m', 'embed'])
    assert.equal(git(worktree.path, ['status', '--porcelain', '--ignore-submodules=none']), '')

    assert.notEqual((await removeRegisteredWorktreeCheckout(repo, worktree.path)).code, 0)
    assert.equal(await readFile(join(own, 'own.txt'), 'utf8'), 'only here\n')
  })

  it('archives submodule-only work only once the user confirms that exact state', async () => {
    const { repo } = await setup()
    const worktree = await allocate(repo)
    const lib = join(worktree.path, 'vendor', 'lib')
    const base = git(lib, ['rev-parse', 'HEAD'])
    git(lib, ['switch', '-q', '-c', 'work'])
    await commitFiles(lib, { 'lib.txt': 'changed\n' }, 'thread work')
    git(lib, ['switch', '-q', '--detach', base])
    const keep = async (): Promise<() => Promise<void>> => async () => {}

    const blocked = await archiveThreadWorktree(input(repo, worktree), null, keep)
    assert.equal(blocked.status, 'blocked-dirty')
    assert.ok(blocked.paths.includes('vendor/lib'))

    const archived = await archiveThreadWorktree(input(repo, worktree), blocked.fingerprint, keep)
    assert.equal(archived.status, 'removed')
    assert.equal(await exists(worktree.path), false)
  })
})
