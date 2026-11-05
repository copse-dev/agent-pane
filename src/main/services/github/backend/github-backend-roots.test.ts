import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type { GhPrSummary } from '@shared/types/git.ts'
import { ghCliBackend } from './gh-cli-backend.ts'
import { cachingGitHubBackend, resetGitHubReadCacheForTest } from './github-read-cache.ts'
import { resetGitHubApiTokenCacheForTest, resolveGitHubApiToken } from './github-token.ts'
import type { GitHubBackend, PrRef } from './backend.ts'
import { invalidateGitWorkTreeProbe } from '../git-service.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../../tool-availability.ts'
import { setWorkspaceRootForTest } from '../../workspace.ts'

const posix = process.platform !== 'win32'
const gitOk = spawnSync('git', ['--version']).status === 0

const TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]

/**
 * #3958: `GitHubBackend` and `github-token` no longer run `gh` in the window's
 * workspace. A fake `gh` on PATH records the directory each call runs in, so
 * two callers in two checkouts can ask at once while the process-global
 * workspace points at a third, and each call is seen to run where its caller
 * said.
 */
describe('GitHub backend with two roots at once', { skip: !posix || !gitOk }, () => {
  const dirs = { bin: '', alpha: '', beta: '', window: '' }
  const savedEnv: Record<string, string | undefined> = {}
  let restoreWorkspace: (() => void) | undefined

  async function makeRepo(name: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `copse-gh-roots-${name}-`)))
    const git = (...args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/acme/${name}.git`)
    return root
  }

  /** Every `gh` invocation as `<physical cwd> <args...>`, in call order. */
  async function calls(): Promise<string[]> {
    const text = await readFile(join(dirs.bin, 'calls.log'), 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean)
  }

  before(async () => {
    dirs.bin = await realpath(await mkdtemp(join(tmpdir(), 'copse-gh-roots-bin-')))
    const log = join(dirs.bin, 'calls.log')
    // Records where it ran; `auth token` answers with that directory so the
    // token itself shows where the lookup happened.
    await writeFile(
      join(dirs.bin, 'gh'),
      [
        '#!/bin/sh',
        'dir=$(pwd -P)',
        `echo "$dir $*" >> '${log}'`,
        'if [ "$1" = auth ] && [ "$2" = token ]; then echo "token-for:$dir"; exit 0; fi',
        'sleep 0.05',
        'if [ "$1" = pr ] && [ "$2" = list ]; then',
        '  echo "[{\\"number\\":1,\\"title\\":\\"$dir\\",\\"url\\":\\"https://github.com/x/y/pull/1\\"}]"',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    dirs.alpha = await makeRepo('alpha')
    dirs.beta = await makeRepo('beta')
    dirs.window = await makeRepo('window')
    for (const key of [...TOKEN_ENV_KEYS, 'PATH', 'COPSE_PRESERVE_PATH']) {
      savedEnv[key] = process.env[key]
    }
    for (const key of TOKEN_ENV_KEYS) Reflect.deleteProperty(process.env, key)
    // Put the fake ahead of any real `gh` (the probe PATH otherwise leads with /usr/bin).
    process.env['COPSE_PRESERVE_PATH'] = '1'
    process.env['PATH'] = `${dirs.bin}:${savedEnv['PATH'] ?? '/usr/bin:/bin'}`
    restoreWorkspace = setWorkspaceRootForTest(dirs.window)
  })

  after(async () => {
    restoreWorkspace?.()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    for (const dir of Object.values(dirs)) await rm(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await rm(join(dirs.bin, 'calls.log'), { force: true })
    setGitAvailableForTest(true)
    setGhAvailableForTest(true)
    invalidateGitWorkTreeProbe()
    resetGitHubReadCacheForTest()
    resetGitHubApiTokenCacheForTest()
  })

  afterEach(() => {
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
  })

  const REF: PrRef = { owner: 'acme', repo: 'shared', number: 7 }

  it("runs each CLI call in its caller's checkout, never the window workspace", async () => {
    await Promise.all([
      ghCliBackend.approvePr(dirs.alpha, REF),
      ghCliBackend.approvePr(dirs.beta, REF),
    ])
    const seen = await calls()
    assert.equal(seen.length, 2)
    assert.deepEqual(seen.map((line) => line.split(' ')[0]).sort(), [dirs.alpha, dirs.beta].sort())
    assert.ok(seen.every((line) => !line.startsWith(dirs.window)))
  })

  it("takes each workspace list from its own checkout's origin", async () => {
    const [alpha, beta] = await Promise.all([
      ghCliBackend.listWorkspaceOpenPrs(dirs.alpha, 5),
      ghCliBackend.listWorkspaceOpenPrs(dirs.beta, 5),
    ])
    const seen = await calls()
    assert.ok(seen.some((line) => line === `${dirs.alpha} ${listArgs('acme/alpha')}`))
    assert.ok(seen.some((line) => line === `${dirs.beta} ${listArgs('acme/beta')}`))
    assert.ok(seen.every((line) => !line.includes('acme/window')))
    assert.deepEqual(titles(alpha), [dirs.alpha])
    assert.deepEqual(titles(beta), [dirs.beta])
  })

  it('refuses a CLI call with no root rather than borrowing the window workspace', async () => {
    const result = await ghCliBackend.approvePr(null, REF)
    assert.equal(result.ok, false)
    assert.deepEqual(await calls(), [])
  })

  it('keeps cached workspace lists apart per root', async () => {
    const cached: GitHubBackend = cachingGitHubBackend(ghCliBackend)
    const [alpha, beta] = await Promise.all([
      cached.listWorkspaceOpenPrs(dirs.alpha, 5),
      cached.listWorkspaceOpenPrs(dirs.beta, 5),
    ])
    // A second read per root is served from that root's own slot.
    const [alphaAgain, betaAgain] = await Promise.all([
      cached.listWorkspaceOpenPrs(dirs.alpha, 5),
      cached.listWorkspaceOpenPrs(dirs.beta, 5),
    ])
    assert.deepEqual(titles(alpha), [dirs.alpha])
    assert.deepEqual(titles(beta), [dirs.beta])
    assert.deepEqual(titles(alphaAgain), [dirs.alpha])
    assert.deepEqual(titles(betaAgain), [dirs.beta])
    assert.equal((await calls()).filter((line) => line.includes(' pr list ')).length, 2)
  })

  it('looks the API token up in the home directory, not any project', async () => {
    const tokens = await Promise.all([resolveGitHubApiToken(), resolveGitHubApiToken()])
    const home = await realpath(homedir())
    assert.deepEqual(tokens, [`token-for:${home}`, `token-for:${home}`])
    const seen = await calls()
    assert.ok(seen.length >= 1)
    assert.ok(seen.every((line) => line === `${home} auth token`))
  })
})

function listArgs(slug: string): string {
  return [
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'open',
    '--limit',
    '5',
    '--json',
    'number,title,url,state,headRefName,author,createdAt,updatedAt,statusCheckRollup',
  ].join(' ')
}

function titles(prs: GhPrSummary[]): string[] {
  return prs.map((pr) => pr.title)
}
