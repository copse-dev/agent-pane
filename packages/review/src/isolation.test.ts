import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import {
  CELL_ENV_ALLOWLIST,
  cellEnvironment,
  decideExecution,
  droppedHostSecrets,
  type DiffOrigin,
  type IsolationStrength,
} from './isolation.ts'

describe('decideExecution', () => {
  const strengths: readonly IsolationStrength[] = ['none', 'os-sandbox', 'container']
  const origins: readonly DiffOrigin[] = ['own', 'foreign']

  it('matches the trust × isolation table for every cell', () => {
    const expected: Record<DiffOrigin, Record<IsolationStrength, [boolean, boolean]>> = {
      // [without consent, with consent]
      own: { none: [false, true], 'os-sandbox': [true, true], container: [true, true] },
      foreign: { none: [false, false], 'os-sandbox': [false, false], container: [true, true] },
    }
    for (const diffOrigin of origins) {
      for (const strength of strengths) {
        const [noConsent, consent] = expected[diffOrigin][strength]
        assert.equal(
          decideExecution({ diffOrigin, strength, unisolatedConsent: false }).execute,
          noConsent,
          `${diffOrigin} / ${strength} / no consent`,
        )
        assert.equal(
          decideExecution({ diffOrigin, strength, unisolatedConsent: true }).execute,
          consent,
          `${diffOrigin} / ${strength} / consent`,
        )
      }
    }
  })

  it('names the binding decision that refuses a foreign diff', () => {
    assert.match(
      decideExecution({ diffOrigin: 'foreign', strength: 'os-sandbox', unisolatedConsent: true })
        .reason,
      /B3/,
    )
    assert.match(
      decideExecution({ diffOrigin: 'foreign', strength: 'none', unisolatedConsent: true }).reason,
      /B1/,
    )
  })
})

describe('cellEnvironment', () => {
  const host = {
    PATH: '/usr/bin',
    LANG: 'en_GB.UTF-8',
    HOME: '/Users/someone',
    ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key-but-long-enough',
    GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz1234',
    SHORT: 'x',
    EMPTY: undefined,
  }

  it('passes only the allowlist, plus CI and NO_COLOR', () => {
    const env = cellEnvironment(host)
    assert.deepEqual(Object.keys(env).sort(), [
      'CI',
      'COREPACK_ENABLE_NETWORK',
      'LANG',
      'NO_COLOR',
      'PATH',
    ])
    assert.equal(env['COREPACK_ENABLE_NETWORK'], '0')
    assert.equal(env['PATH'], '/usr/bin')
    const allowlisted = new Set<string>(CELL_ENV_ALLOWLIST)
    for (const key of Object.keys(env)) {
      assert.ok(
        key === 'CI' ||
          key === 'NO_COLOR' ||
          key === 'COREPACK_ENABLE_NETWORK' ||
          allowlisted.has(key),
        `${key} is not allowlisted`,
      )
    }
  })

  it('points pnpm at the checkout-local read-only-store alias when given one', () => {
    assert.equal(
      cellEnvironment(host, { pnpmStoreDir: '.copse-review-pnpm-store/store' })[
        'npm_config_store_dir'
      ],
      '.copse-review-pnpm-store/store',
    )
    assert.equal(Object.hasOwn(cellEnvironment(host), 'npm_config_store_dir'), false)
    assert.equal(cellEnvironment(host, { corepackHome: '/corepack' })['COREPACK_HOME'], '/corepack')
    assert.equal(Object.hasOwn(cellEnvironment(host), 'COREPACK_HOME'), false)
  })

  it('reports every dropped value long enough to be a credential as a literal secret', () => {
    const secrets = droppedHostSecrets(host)
    assert.deepEqual([...secrets].sort(), [host.ANTHROPIC_API_KEY, host.GITHUB_TOKEN].sort())
    assert.equal(secrets.includes('x'), false, 'a one-character flag is not a secret')
    assert.equal(secrets.includes('/usr/bin'), false, 'an allowlisted value is not dropped')
  })
})

describe('droppedHostSecrets', () => {
  const home = '/Users/someone-with-a-long-name'
  const repo = `${home}/src/agent-pane`
  const host = {
    HOME: home,
    USER: 'someone-with-a-long-name',
    PWD: repo,
    SHELL: '/bin/zsh',
    TMPDIR: '/var/folders/zz/abcdefgh/T/',
    LC_TIME: 'en_GB.UTF-8',
    npm_package_name: 'copse-panel',
    npm_package_json: `${repo}/package.json`,
    npm_lifecycle_event: 'review:stage0',
    GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz1234',
    FOO_KEY: randomBytes(24).toString('base64url'),
    // Neighbours of exempt names that can carry a credential.
    npm_config__authToken: 'registry-token-from-the-npmrc',
    npm_package_config_token: 'overridden-from-the-npmrc',
    npm_lifecycle_script: 'copse-review pr --flag-holding-a-credential',
    LC_DEPLOY: 'smuggled-over-ssh-sendenv',
    // What a macOS shell with Homebrew and nvm exports.
    HOMEBREW_PREFIX: '/opt/homebrew',
    HOMEBREW_CELLAR: '/opt/homebrew/Cellar',
    HOMEBREW_REPOSITORY: '/opt/homebrew',
    NVM_DIR: `${home}/.nvm`,
    NVM_BIN: `${home}/.nvm/versions/node/v24.22.1/bin`,
    NVM_INC: `${home}/.nvm/versions/node/v24.22.1/include/node`,
    COMMAND_MODE: 'unix2003',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    __CFBundleIdentifier: 'com.apple.Terminal',
    // Redacted by name: the value need not look like a GitHub token.
    HOMEBREW_GITHUB_API_TOKEN: 'homebrew-credential-in-the-shell',
  }

  it('exempts session, locale and script metadata but not their credential-bearing neighbours', () => {
    assert.deepEqual(
      [...droppedHostSecrets(host)].sort(),
      [
        host.GITHUB_TOKEN,
        host.FOO_KEY,
        host.npm_config__authToken,
        host.npm_package_config_token,
        host.npm_lifecycle_script,
        host.LC_DEPLOY,
        host.HOMEBREW_GITHUB_API_TOKEN,
      ].sort(),
    )
    assert.equal(Object.hasOwn(cellEnvironment(host), 'HOME'), false, 'HOME still stays out')
  })

  it('keeps host paths readable in scrubbed output while redacting credentials', () => {
    const failure = [
      `Error at file://${repo}/packages/review/ci/prepare-npm-checkout.mts:22`,
      `    at ${host.NVM_BIN}/node and /opt/homebrew/bin/git`,
    ].join('\n')
    const output = `${failure}\nGITHUB_TOKEN=${host.GITHUB_TOKEN}\nFOO_KEY=${host.FOO_KEY}`
    const scrubbed = redactSecrets(output, droppedHostSecrets(host))
    assert.ok(scrubbed.startsWith(failure), scrubbed)
    assert.equal(scrubbed.includes(host.GITHUB_TOKEN), false)
    assert.equal(scrubbed.includes(host.FOO_KEY), false)
  })

  it('still redacts an exempt value that another dropped variable also carries', () => {
    const shared = 'someone-with-a-long-name'
    assert.deepEqual(droppedHostSecrets({ USER: shared, DB_PASSWORD: shared }), [shared])
  })
})
