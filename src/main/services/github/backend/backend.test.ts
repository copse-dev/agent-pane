import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideBackendKind } from './backend.ts'

describe('decideBackendKind', () => {
  it('honors an explicit cli/api preference', () => {
    assert.equal(
      decideBackendKind({ preference: 'cli', ghAvailable: false, hasApiToken: true }),
      'cli',
    )
    assert.equal(
      decideBackendKind({ preference: 'api', ghAvailable: true, hasApiToken: false }),
      'api',
    )
  })

  it('auto prefers the cli when gh is available', () => {
    assert.equal(
      decideBackendKind({ preference: 'auto', ghAvailable: true, hasApiToken: true }),
      'cli',
    )
  })

  it('auto falls back to the api only when gh is absent and a token exists', () => {
    assert.equal(
      decideBackendKind({ preference: 'auto', ghAvailable: false, hasApiToken: true }),
      'api',
    )
    // No gh and no token → stay on cli so its status can guide the user to install/sign in.
    assert.equal(
      decideBackendKind({ preference: 'auto', ghAvailable: false, hasApiToken: false }),
      'cli',
    )
  })
})
