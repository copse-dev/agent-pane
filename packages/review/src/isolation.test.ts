import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
    assert.deepEqual(
      [...secrets].sort(),
      ['/Users/someone', host.ANTHROPIC_API_KEY, host.GITHUB_TOKEN].sort(),
    )
    assert.equal(secrets.includes('x'), false, 'a one-character flag is not a secret')
    assert.equal(secrets.includes('/usr/bin'), false, 'an allowlisted value is not dropped')
  })
})
