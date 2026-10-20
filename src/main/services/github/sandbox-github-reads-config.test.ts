import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserRequestRefusal,
  presentedSecret,
  sameSecret,
  sandboxGhConfigFiles,
  sandboxGitHubEnv,
  SANDBOX_GITHUB_SESSION_HEADER,
  sessionAliasHost,
  sessionIdFromAliasHost,
} from './sandbox-github-reads-config.ts'

const ALIAS = 's0123456789abcdef.github.copse.internal'
const SECRET = `copse_sgh_${'ab'.repeat(32)}`

describe('session alias hosts', () => {
  it('round-trips a session id and rejects anything else', () => {
    assert.equal(sessionAliasHost('s0123456789abcdef'), ALIAS)
    assert.equal(sessionIdFromAliasHost(ALIAS), 's0123456789abcdef')
    assert.equal(sessionIdFromAliasHost(ALIAS.toUpperCase()), 's0123456789abcdef')
    for (const host of [
      'github.copse.internal',
      'evil.s0123456789abcdef.github.copse.internal',
      's0123456789abcdef.github.copse.internal.evil.com',
      's0123.github.copse.internal',
      's0123456789abcdeg.github.copse.internal',
    ]) {
      assert.equal(sessionIdFromAliasHost(host), null, host)
    }
    assert.throws(() => sessionAliasHost('../x'))
  })
})

describe('sandboxGitHubEnv', () => {
  it('rewrites every github.com remote form to the alias and sends the secret as a header', () => {
    const env = sandboxGitHubEnv({}, { aliasHost: ALIAS, secret: SECRET, ghConfigDir: null })
    const pairs: Array<[string | undefined, string | undefined]> = []
    for (let i = 0; i < Number(env['GIT_CONFIG_COUNT']); i++) {
      pairs.push([env[`GIT_CONFIG_KEY_${String(i)}`], env[`GIT_CONFIG_VALUE_${String(i)}`]])
    }
    const base = `http://${ALIAS}/`
    assert.deepEqual(pairs, [
      [`url.${base}.insteadOf`, 'https://github.com/'],
      [`url.${base}.insteadOf`, 'git@github.com:'],
      [`url.${base}.insteadOf`, 'ssh://git@github.com/'],
      [`http.${base}.extraHeader`, `${SANDBOX_GITHUB_SESSION_HEADER}: ${SECRET}`],
      [`credential.${base}.helper`, ''],
    ])
  })

  it('appends after configuration the environment already carries', () => {
    const env = sandboxGitHubEnv(
      { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' },
      { aliasHost: ALIAS, secret: SECRET, ghConfigDir: null },
    )
    assert.equal(env['GIT_CONFIG_COUNT'], '7')
    assert.equal(env['GIT_CONFIG_KEY_0'], undefined)
    assert.equal(env['GIT_CONFIG_KEY_2'], `url.http://${ALIAS}/.insteadOf`)
    assert.ok(!Object.hasOwn(env, 'GIT_CONFIG_KEY_0'))
  })

  it('points gh at its config directory and unsets host tokens only when gh is routed', () => {
    const withGh = sandboxGitHubEnv(
      { GH_TOKEN: 'ghp_real', GITHUB_TOKEN: 'ghp_real' },
      { aliasHost: ALIAS, secret: SECRET, ghConfigDir: '/private/tmp/x/gh' },
    )
    assert.equal(withGh['GH_CONFIG_DIR'], '/private/tmp/x/gh')
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
      assert.ok(Object.hasOwn(withGh, key), key)
      assert.equal(withGh[key], undefined, key)
    }
    const gitOnly = sandboxGitHubEnv({}, { aliasHost: ALIAS, secret: SECRET, ghConfigDir: null })
    assert.ok(!Object.hasOwn(gitOnly, 'GH_CONFIG_DIR'))
    assert.ok(!Object.hasOwn(gitOnly, 'GH_TOKEN'))
  })
})

describe('sandboxGhConfigFiles', () => {
  it('names the socket and holds the session secret, nothing else', () => {
    const files = sandboxGhConfigFiles({ socketPath: '/tmp/a b/gh.sock', secret: SECRET })
    assert.match(files['config.yml'], /^http_unix_socket: "\/tmp\/a b\/gh\.sock"$/m)
    assert.match(files['hosts.yml'], new RegExp(`oauth_token: "${SECRET}"`))
  })
})

describe('request credential checks', () => {
  it('reads the secret from the route-specific header only', () => {
    assert.equal(presentedSecret('gh', [['Authorization', `token ${SECRET}`]]), SECRET)
    assert.equal(presentedSecret('gh', [['authorization', `Bearer ${SECRET}`]]), SECRET)
    assert.equal(presentedSecret('gh', [[SANDBOX_GITHUB_SESSION_HEADER, SECRET]]), null)
    assert.equal(presentedSecret('gh', []), null)
    assert.equal(
      presentedSecret('gh', [
        ['Authorization', `token ${SECRET}`],
        ['Authorization', `token ${SECRET}`],
      ]),
      null,
    )
    assert.equal(presentedSecret('git', [[SANDBOX_GITHUB_SESSION_HEADER, ` ${SECRET} `]]), SECRET)
    assert.equal(presentedSecret('git', [['Authorization', `token ${SECRET}`]]), null)
  })

  it('compares secrets exactly', () => {
    assert.equal(sameSecret(SECRET, SECRET), true)
    assert.equal(sameSecret(`${SECRET}0`, SECRET), false)
    assert.equal(sameSecret(SECRET.slice(0, -1), SECRET), false)
    assert.equal(sameSecret('', SECRET), false)
  })

  it('refuses requests that carry browser headers', () => {
    assert.equal(browserRequestRefusal([['Host', 'api.github.com']]), null)
    assert.notEqual(browserRequestRefusal([['Origin', 'https://evil.example']]), null)
    assert.notEqual(browserRequestRefusal([['Sec-Fetch-Site', 'cross-site']]), null)
    assert.notEqual(browserRequestRefusal([['sec-fetch-mode', 'no-cors']]), null)
  })
})
