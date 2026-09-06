import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasLastUsage } from './provider-usage.ts'

describe('hasLastUsage', () => {
  it('detects providers exposing a lastUsage field', () => {
    assert.equal(hasLastUsage({ lastUsage: { inputTokens: 1, outputTokens: 2 } }), true)
    assert.equal(hasLastUsage({ lastUsage: null }), true)
  })

  it('rejects providers without a lastUsage field', () => {
    assert.equal(hasLastUsage({}), false)
    assert.equal(hasLastUsage({ stream: () => {} }), false)
  })

  it('rejects non-objects', () => {
    assert.equal(hasLastUsage(null), false)
    assert.equal(hasLastUsage(undefined), false)
    assert.equal(hasLastUsage('lastUsage'), false)
    assert.equal(hasLastUsage(42), false)
  })
})
