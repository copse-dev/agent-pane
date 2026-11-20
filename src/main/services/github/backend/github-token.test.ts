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
  githubNoTokenMessage,
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

  it('normalises how GH_HOST is spelled before anything chooses a token', () => {
    const cases: Array<[string, string]> = [
      ['GitHub.com', 'github.com'],
      ['github.com.', 'github.com'],
      ['github.com:443', 'github.com'],
      ['github.com.:443', 'github.com'],
      ['api.github.com', 'github.com'],
      ['GHE.Example.com.', ENTERPRISE_HOST],
      [`${ENTERPRISE_HOST}:443`, ENTERPRISE_HOST],
      [`${ENTERPRISE_HOST}:8443`, `${ENTERPRISE_HOST}:8443`],
      ['acme.ghe.com', 'acme.ghe.com'],
      ['10.0.0.5', '10.0.0.5'],
    ]
    for (const [raw, host] of cases) assert.equal(githubApiHost({ GH_HOST: raw }), host, raw)
  })

  it('refuses a GH_HOST that is not a bare host and port', () => {
    for (const raw of [
      `https://${ENTERPRISE_HOST}`,
      `${ENTERPRISE_HOST}/api/v3`,
      `user@${ENTERPRISE_HOST}`,
      'ghe..example.com',
      '-ghe.example.com',
      `${ENTERPRISE_HOST}:0`,
      `${ENTERPRISE_HOST}:70000`,
      '[::1]',
      // github.com, a ghe.com tenancy or github.localhost on another port is not GitHub.
      'github.com:8443',
      'api.github.com:80',
      'acme.ghe.com:8443',
    ]) {
      assert.equal(githubApiHost({ GH_HOST: raw }), null, raw)
    }
  })

  it('counts only a token for the host the backend talks to', () => {
    assert.equal(hasGitHubApiToken({ GITHUB_TOKEN: 'github-token' }), true)
    assert.equal(hasGitHubApiToken({ GH_ENTERPRISE_TOKEN: 'gh-enterprise-token' }), false)
    assert.equal(
      hasGitHubApiToken({ GH_HOST: ENTERPRISE_HOST, GH_ENTERPRISE_TOKEN: 'gh-enterprise-token' }),
      true,
    )
    assert.equal(hasGitHubApiToken({ GH_HOST: ENTERPRISE_HOST, GH_TOKEN: 'gh-token' }), false)
    assert.equal(hasGitHubApiToken({ GH_HOST: 'GitHub.com:443', GH_TOKEN: 'gh-token' }), true)
    assert.equal(
      hasGitHubApiToken({ GH_HOST: 'github.com.', GH_ENTERPRISE_TOKEN: 'gh-enterprise-token' }),
      false,
    )
    assert.equal(
      hasGitHubApiToken({
        GH_HOST: `https://${ENTERPRISE_HOST}`,
        GH_ENTERPRISE_TOKEN: 'gh-enterprise-token',
      }),
      false,
    )
  })
})

describe('githubNoTokenMessage', () => {
  it('names the github.com variables and gh auth login for github.com', () => {
    assert.equal(
      githubNoTokenMessage('github.com'),
      'No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`.',
    )
  })

  it('names GH_ENTERPRISE_TOKEN and the host login for an Enterprise host', () => {
    const message = githubNoTokenMessage(ENTERPRISE_HOST)
    assert.equal(
      message,
      `No GitHub token available for ${ENTERPRISE_HOST}. Set GH_ENTERPRISE_TOKEN, or run \`gh auth login --hostname ${ENTERPRISE_HOST}\`.`,
    )
    assert.doesNotMatch(message, /GITHUB_TOKEN|GH_TOKEN /)
  })

  it('says GH_HOST needs fixing when it was refused', () => {
    assert.match(githubNoTokenMessage(null), /^GH_HOST is not a host name\./)
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

  it('asks gh for the normalised host, and for nothing when GH_HOST is refused', async () => {
    process.env['GH_HOST'] = 'GitHub.com.:443'
    process.env['GH_ENTERPRISE_TOKEN'] = 'gh-enterprise-token'
    assert.equal(await resolveGitHubApiToken(), 'gh-login-for:github.com')
    process.env['GH_HOST'] = `https://${ENTERPRISE_HOST}`
    assert.equal(await resolveGitHubApiToken(), null)
    assert.deepEqual(await authTokenCalls(), ['auth token --hostname github.com'])
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
