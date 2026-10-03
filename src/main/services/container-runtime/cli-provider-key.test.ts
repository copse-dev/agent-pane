import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { takeProviderKeyFromEnv } from './cli-provider-key.ts'

describe('takeProviderKeyFromEnv', () => {
  it('returns the key and removes it so Docker subprocesses cannot inherit it', () => {
    const env: NodeJS.ProcessEnv = { PROVIDER_KEY: 'sk-secret', PATH: '/usr/bin' }
    assert.equal(takeProviderKeyFromEnv('PROVIDER_KEY', env), 'sk-secret')
    assert.equal(Object.hasOwn(env, 'PROVIDER_KEY'), false)
    assert.equal(env['PATH'], '/usr/bin')
  })

  it('returns undefined for an unnamed or unset variable', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    assert.equal(takeProviderKeyFromEnv(undefined, env), undefined)
    assert.equal(takeProviderKeyFromEnv('MISSING_KEY', env), undefined)
    assert.deepEqual(env, { PATH: '/usr/bin' })
  })
})
