import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchFromOriginOnHost, fetchThroughScratchRepository } from './default-branch-fetch.ts'
import { fetchOriginRefs, isFetchableBranchName, parseFetchTargets } from './git-fetch-origin.ts'
import { runWorktreeGit } from './worktree-manager.ts'
import { gitFetchTool } from '../tools/git-fetch-tool.ts'

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

describe('parseFetchTargets', () => {
  it('maps branches and PR heads to fixed origin remote-tracking refs', () => {
    const parsed = parseFetchTargets(['main', 'feature/x', 'refs/pull/42/head', 'main'])
    assert.deepEqual(parsed, {
      ok: true,
      refs: [
        { source: 'refs/heads/main', destination: 'refs/remotes/origin/main' },
        { source: 'refs/heads/feature/x', destination: 'refs/remotes/origin/feature/x' },
        { source: 'refs/pull/42/head', destination: 'refs/remotes/origin/pr/42' },
      ],
    })
  })

  it('refuses refspecs, remotes, URLs, options and revision syntax', () => {
    for (const name of [
      'main:refs/heads/main',
      '+main:main',
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/pull/0/head',
      'refs/pull/1/merge',
      'HEAD',
      '@',
      'https://github.com/o/r.git',
      'git@github.com:o/r.git',
      '/srv/repo.git',
      '--upload-pack=touch /tmp/x',
      '-oProxyCommand=x',
      'main..dev',
      'main@{1}',
      'main~1',
      'main^',
      'feature/.hidden',
      'feature/x.lock',
      'a//b',
      'trailing/',
      'trailing.',
      'with space',
      'new\nline',
      '',
    ]) {
      assert.equal(parseFetchTargets([name]).ok, false, JSON.stringify(name))
      if (name !== '') assert.equal(isFetchableBranchName(name), false, JSON.stringify(name))
    }
  })

  it('bounds the number of refs', () => {
    assert.equal(parseFetchTargets([]).ok, false)
    assert.equal(parseFetchTargets(Array.from({ length: 21 }, (_, i) => `b${String(i)}`)).ok, false)
  })
})

describe('git_fetch tool arguments', () => {
  it('has no remote, URL, refspec or option field', () => {
    for (const extra of [{ remote: 'upstream' }, { url: 'https://x' }, { refspec: '+a:b' }]) {
      assert.equal(gitFetchTool.parameters.safeParse({ refs: ['main'], ...extra }).success, false)
    }
    assert.equal(gitFetchTool.parameters.safeParse({ refs: ['main'] }).success, true)
  })
})

describe('fetchOriginRefs', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  async function fixture(): Promise<{
    temp: string
    project: string
    remote: string
    fetchFromOrigin: typeof fetchFromOriginOnHost
  }> {
    // The sandbox overlay rejects redirected grants (macOS /var -> /private/var).
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-git-fetch-')))
    cleanups.push(temp)
    const remote = join(temp, 'remote.git')
    git(temp, ['init', '-q', '--bare', '-b', 'main', remote])
    const project = join(temp, 'project')
    git(temp, ['clone', '-q', remote, project])
    git(project, ['checkout', '-q', '-b', 'main'])
    await commit(project, 'README.md', 'initial')
    git(project, ['push', '-q', 'origin', 'main'])
    // The production path admits only network origins; a local bare origin
    // stands in for one here, through the same scratch-repository fetch.
    const scratch = join(temp, 'scratch.git')
    const fetchFromOrigin: typeof fetchFromOriginOnHost = (projectRoot, refs, projectGit) =>
      fetchThroughScratchRepository({ projectRoot, url: remote, refs, scratch, projectGit })
    return { temp, project, remote, fetchFromOrigin }
  }

  it('fetches a branch and a PR head into remote-tracking refs only', async () => {
    const { temp, project, remote, fetchFromOrigin } = await fixture()
    const elsewhere = join(temp, 'elsewhere')
    git(temp, ['clone', '-q', remote, elsewhere])
    git(elsewhere, ['checkout', '-q', '-b', 'feature/x'])
    await commit(elsewhere, 'feature.txt', 'feature')
    git(elsewhere, ['push', '-q', 'origin', 'feature/x'])
    const featureTip = git(elsewhere, ['rev-parse', 'HEAD']).trim()
    await commit(elsewhere, 'pr.txt', 'pull request head')
    const prTip = git(elsewhere, ['rev-parse', 'HEAD']).trim()
    // GitHub publishes PR heads under refs/pull/<n>/head.
    git(elsewhere, ['push', '-q', 'origin', 'HEAD:refs/pull/7/head'])
    const head = git(project, ['rev-parse', 'HEAD']).trim()
    const localBranches = git(project, ['for-each-ref', 'refs/heads']).trim()

    const text = await fetchOriginRefs(
      project,
      ['feature/x', 'refs/pull/7/head'],
      runWorktreeGit,
      fetchFromOrigin,
    )

    assert.match(text, /^Fetched from origin:/)
    assert.match(text, new RegExp(`refs/remotes/origin/feature/x ${featureTip} \\(new;`))
    assert.match(text, new RegExp(`refs/remotes/origin/pr/7 ${prTip} \\(new;`))
    assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/feature/x']).trim(), featureTip)
    assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/pr/7']).trim(), prTip)
    assert.equal(git(project, ['rev-parse', 'HEAD']).trim(), head)
    assert.equal(git(project, ['for-each-ref', 'refs/heads']).trim(), localBranches)
    assert.equal(git(project, ['status', '--porcelain=v1']).trim(), '')
    assert.equal(existsSync(join(temp, 'scratch.git')), false)
  })

  it('refuses before fetching anything', async () => {
    const { project, fetchFromOrigin } = await fixture()
    let fetched = false
    const text = await fetchOriginRefs(
      project,
      ['--upload-pack=touch pwned'],
      runWorktreeGit,
      async (...args) => {
        fetched = true
        return fetchFromOrigin(...args)
      },
    )
    assert.match(text, /^git_fetch refused:/)
    assert.equal(fetched, false)
  })

  it('reports a missing remote branch without moving any ref', async () => {
    const { project, fetchFromOrigin } = await fixture()
    const before = git(project, ['for-each-ref']).trim()
    const text = await fetchOriginRefs(project, ['no-such-branch'], runWorktreeGit, fetchFromOrigin)
    assert.match(text, /^git_fetch failed:/)
    assert.equal(git(project, ['for-each-ref']).trim(), before)
  })

  it('declines a project whose origin is not a network remote', async () => {
    const { project } = await fixture()
    const text = await fetchOriginRefs(project, ['main'], runWorktreeGit)
    assert.match(text, /only fetches from an origin with an https:\/\/, ssh:\/\//)
  })
})
