import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchThroughScratchRepository,
  isNetworkRemoteUrl,
  originBranchRef,
} from './default-branch-fetch.ts'
import { runWorktreeGit } from './worktree-manager.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
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

async function commit(repo: string, file: string, message: string): Promise<void> {
  await writeFile(join(repo, file), `${message}\n`)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', message])
}

describe('isNetworkRemoteUrl', () => {
  it('admits network transports only', () => {
    for (const url of [
      'git@github.com:copse-dev/agent-pane.git',
      'ssh://git@github.com/copse-dev/agent-pane.git',
      'https://github.com/copse-dev/agent-pane.git',
      'http://git.example.internal/repo.git',
    ]) {
      assert.equal(isNetworkRemoteUrl(url), true, url)
    }
    for (const url of [
      '',
      '/srv/repos/project.git',
      '../project.git',
      'file:///srv/repos/project.git',
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      '-oProxyCommand=touch /tmp/pwned',
      'https://github.com/a b.git',
    ]) {
      assert.equal(isNetworkRemoteUrl(url), false, url)
    }
  })
})

describe('fetchThroughScratchRepository', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  async function fixture(): Promise<{ temp: string; project: string; remote: string }> {
    // The sandbox overlay rejects redirected grants (macOS /var -> /private/var).
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-default-branch-fetch-')))
    cleanups.push(temp)
    const remote = join(temp, 'remote.git')
    git(temp, ['init', '-q', '--bare', '-b', 'main', remote])
    const project = join(temp, 'project')
    git(temp, ['clone', '-q', remote, project])
    git(project, ['checkout', '-q', '-b', 'main'])
    await commit(project, 'README.md', 'initial')
    git(project, ['push', '-q', 'origin', 'main'])
    return { temp, project, remote }
  }

  async function advanceRemote(temp: string, remote: string): Promise<string> {
    const elsewhere = join(temp, 'elsewhere')
    git(temp, ['clone', '-q', remote, elsewhere])
    await commit(elsewhere, 'upstream.txt', 'pushed elsewhere')
    git(elsewhere, ['push', '-q', 'origin', 'main'])
    return git(remote, ['rev-parse', 'main']).trim()
  }

  it('moves only origin/<branch>, ignoring the project config, and removes the scratch', async () => {
    const { temp, project, remote } = await fixture()
    const remoteTip = await advanceRemote(temp, remote)
    const localTip = git(project, ['rev-parse', 'main']).trim()
    // Project-local config the host-side fetch must never consult: were the
    // network step run in the project, this rewrite would send it nowhere.
    git(project, ['config', 'url./nonexistent/.insteadOf', remote])
    const scratch = join(temp, 'scratch.git')

    const result = await fetchThroughScratchRepository({
      projectRoot: project,
      url: remote,
      refs: [originBranchRef('main')],
      scratch,
      projectGit: runWorktreeGit,
    })

    assert.equal(result.code, 0, result.stderr)
    assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']).trim(), remoteTip)
    assert.equal(git(project, ['rev-parse', 'main']).trim(), localTip)
    assert.equal(git(project, ['status', '--porcelain=v1']).trim(), '')
    assert.equal(existsSync(scratch), false)
  })

  it('fetches a branch the project has never fetched', async () => {
    const { temp, project, remote } = await fixture()
    git(project, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const remoteTip = await advanceRemote(temp, remote)

    const result = await fetchThroughScratchRepository({
      projectRoot: project,
      url: remote,
      refs: [originBranchRef('main')],
      scratch: join(temp, 'scratch.git'),
      projectGit: runWorktreeGit,
    })

    assert.equal(result.code, 0, result.stderr)
    assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']).trim(), remoteTip)
  })

  it('reports an unreachable remote and still removes the scratch', async () => {
    const { temp, project } = await fixture()
    const before = git(project, ['rev-parse', 'refs/remotes/origin/main']).trim()
    const scratch = join(temp, 'scratch.git')

    const result = await fetchThroughScratchRepository({
      projectRoot: project,
      url: join(temp, 'missing.git'),
      refs: [originBranchRef('main')],
      scratch,
      projectGit: runWorktreeGit,
    })

    assert.notEqual(result.code, 0)
    assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']).trim(), before)
    assert.equal(existsSync(scratch), false)
  })

  it('rejects a global rewrite from a network origin to a local repository', async () => {
    const { temp, project, remote } = await fixture()
    await advanceRemote(temp, remote)
    const before = git(project, ['rev-parse', 'refs/remotes/origin/main']).trim()
    const home = join(temp, 'isolated-home')
    await mkdir(home)
    const url = 'https://copse-fetch.invalid/private.git'
    git(temp, ['config', '--file', join(home, '.gitconfig'), `url.file://${remote}.insteadOf`, url])
    const previousHome = process.env['HOME']
    const previousGlobalConfig = process.env['GIT_CONFIG_GLOBAL']
    const scratch = join(temp, 'scratch.git')
    try {
      process.env['HOME'] = home
      // The local test runner may pin a signing-free global config. This case
      // deliberately exercises the isolated HOME's real global rewrite instead.
      delete process.env['GIT_CONFIG_GLOBAL']
      const result = await fetchThroughScratchRepository({
        projectRoot: project,
        url,
        refs: [originBranchRef('main')],
        scratch,
        projectGit: runWorktreeGit,
      })
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /transport 'file' not allowed/)
      assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']).trim(), before)
      assert.equal(existsSync(scratch), false)
    } finally {
      if (previousHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = previousHome
      if (previousGlobalConfig === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = previousGlobalConfig
    }
  })
})
