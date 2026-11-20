/**
 * The API backend's token is chosen by host, the way gh chooses it: github.com
 * gets `GH_TOKEN`, then `GITHUB_TOKEN`, then its own gh login; an Enterprise
 * `GH_HOST` gets `GH_ENTERPRISE_TOKEN`, then `GITHUB_ENTERPRISE_TOKEN`, then
 * its own gh login. A token for one host is never chosen for the other.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  githubApiHost,
  githubTokenFromEnv,
  hasGitHubApiToken,
  resetGitHubApiTokenCacheForTest,
  resolveGitHubApiToken,
} from './github-token.ts'

const ENTERPRISE_HOST = 'ghe.example.com'
const ALL_TOKENS: NodeJS.ProcessEnv = {
  GH_TOKEN: 'gh-token',
  GITHUB_TOKEN: 'github-token',
  GH_ENTERPRISE_TOKEN: 'gh-enterprise-token',
  GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-token',
}

describe('githubTokenFromEnv', () => {
  it('takes GH_TOKEN, then GITHUB_TOKEN, for github.com', () => {
    assert.equal(githubTokenFromEnv('github.com', ALL_TOKENS), 'gh-token')
    assert.equal(
      githubTokenFromEnv('github.com', { ...ALL_TOKENS, GH_TOKEN: '  ' }),
      'github-token',
    )
  })

  it('never takes an Enterprise token for github.com', () => {
    assert.equal(
      githubTokenFromEnv('github.com', {
        GH_ENTERPRISE_TOKEN: 'gh-enterprise-token',
        GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-token',
      }),
      null,
    )
  })

  it('takes GH_ENTERPRISE_TOKEN, then GITHUB_ENTERPRISE_TOKEN, for an Enterprise host', () => {
    assert.equal(githubTokenFromEnv(ENTERPRISE_HOST, ALL_TOKENS), 'gh-enterprise-token')
    assert.equal(
      githubTokenFromEnv(ENTERPRISE_HOST, { ...ALL_TOKENS, GH_ENTERPRISE_TOKEN: '' }),
      'github-enterprise-token',
    )
  })

  it('never takes a github.com token for an Enterprise host', () => {
    assert.equal(
      githubTokenFromEnv(ENTERPRISE_HOST, { GH_TOKEN: 'gh-token', GITHUB_TOKEN: 'github-token' }),
      null,
    )
  })

  it('treats github.com subdomains and ghe.com tenancies as gh does', () => {
    for (const host of ['GitHub.com', 'api.github.com', 'acme.ghe.com', 'api.acme.ghe.com']) {
      assert.equal(githubTokenFromEnv(host, ALL_TOKENS), 'gh-token', host)
    }
    for (const host of ['ghe.com', 'github.com.example.com', 'notgithub.com']) {
      assert.equal(githubTokenFromEnv(host, ALL_TOKENS), 'gh-enterprise-token', host)
    }
  })
})

describe('githubApiHost and hasGitHubApiToken', () => {
  it('takes the host from GH_HOST, else github.com', () => {
    assert.equal(githubApiHost({}), 'github.com')
    assert.equal(githubApiHost({ GH_HOST: '  ' }), 'github.com')
    assert.equal(githubApiHost({ GH_HOST: ` ${ENTERPRISE_HOST} ` }), ENTERPRISE_HOST)
  })

  it('counts only a token for the host the backend talks to', () => {
    assert.equal(hasGitHubApiToken({ GITHUB_TOKEN: 'github-token' }), true)
    assert.equal(hasGitHubApiToken({ GH_ENTERPRISE_TOKEN: 'gh-enterprise-token' }), false)
    assert.equal(
      hasGitHubApiToken({ GH_HOST: ENTERPRISE_HOST, GH_ENTERPRISE_TOKEN: 'gh-enterprise-token' }),
      true,
    )
    assert.equal(hasGitHubApiToken({ GH_HOST: ENTERPRISE_HOST, GH_TOKEN: 'gh-token' }), false)
  })
})

/**
 * A fake `gh` on PATH answers `auth token --hostname <host>` with a token
 * naming that host, and logs every call, so each test sees which host's login
 * was asked for.
 */
describe('resolveGitHubApiToken', { skip: process.platform === 'win32' }, () => {
  const ENV_KEYS = [...Object.keys(ALL_TOKENS), 'GH_HOST', 'PATH', 'COPSE_PRESERVE_PATH']
  const savedEnv: Record<string, string | undefined> = {}
  let bin = ''

  async function authTokenCalls(): Promise<string[]> {
    const text = await readFile(join(bin, 'calls.log'), 'utf8').catch(() => '')
    return text.split('\n').filter((line) => line.startsWith('auth token'))
  }

  before(async () => {
    bin = await realpath(await mkdtemp(join(tmpdir(), 'copse-gh-token-bin-')))
    await writeFile(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${join(bin, 'calls.log')}'`,
        'if [ "$1" = auth ] && [ "$2" = token ]; then',
        '  host=default',
        '  [ "$3" = --hostname ] && host=$4',
        '  echo "gh-login-for:$host"',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    process.env['COPSE_PRESERVE_PATH'] = '1'
    process.env['PATH'] = `${bin}:${savedEnv['PATH'] ?? '/usr/bin:/bin'}`
  })

  after(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    await rm(bin, { recursive: true, force: true })
  })

  beforeEach(async () => {
    for (const key of [...Object.keys(ALL_TOKENS), 'GH_HOST']) {
      Reflect.deleteProperty(process.env, key)
    }
    await rm(join(bin, 'calls.log'), { force: true })
    resetGitHubApiTokenCacheForTest()
  })

  it('asks gh for github.com by name when it has no github.com env token', async () => {
    process.env['GH_HOST'] = ENTERPRISE_HOST
    process.env['GH_ENTERPRISE_TOKEN'] = 'gh-enterprise-token'
    assert.equal(await resolveGitHubApiToken('github.com'), 'gh-login-for:github.com')
    assert.deepEqual(await authTokenCalls(), ['auth token --hostname github.com'])
  })

  it("asks gh for the Enterprise GH_HOST's login when only a github.com token is set", async () => {
    process.env['GH_HOST'] = ENTERPRISE_HOST
    process.env['GH_TOKEN'] = 'gh-token'
    assert.equal(await resolveGitHubApiToken(), `gh-login-for:${ENTERPRISE_HOST}`)
    assert.deepEqual(await authTokenCalls(), [`auth token --hostname ${ENTERPRISE_HOST}`])
  })

  it('uses the env token for the host without asking gh', async () => {
    Object.assign(process.env, ALL_TOKENS)
    assert.equal(await resolveGitHubApiToken(), 'gh-token')
    process.env['GH_HOST'] = ENTERPRISE_HOST
    assert.equal(await resolveGitHubApiToken(), 'gh-enterprise-token')
    assert.deepEqual(await authTokenCalls(), [])
  })

  it("caches each host's gh login on its own", async () => {
    assert.equal(await resolveGitHubApiToken('github.com'), 'gh-login-for:github.com')
    assert.equal(await resolveGitHubApiToken(ENTERPRISE_HOST), `gh-login-for:${ENTERPRISE_HOST}`)
    assert.equal(await resolveGitHubApiToken('github.com'), 'gh-login-for:github.com')
    assert.deepEqual(await authTokenCalls(), [
      'auth token --hostname github.com',
      `auth token --hostname ${ENTERPRISE_HOST}`,
    ])
  })
})
