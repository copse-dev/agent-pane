import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnthropicApiKey, validateOpenAiApiKey } from './validate-api-key.ts'

describe('validateAnthropicApiKey', () => {
  it('rejects empty keys', async () => {
    const result = await validateAnthropicApiKey('   ')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, undefined)
  })

  it('rejects keys with the wrong prefix without a network call', async () => {
    const result = await validateAnthropicApiKey('sk-not-anthropic')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, false)
  })
})

describe('validateOpenAiApiKey', () => {
  it('rejects empty keys', async () => {
    const result = await validateOpenAiApiKey('')
    assert.equal(result.ok, false)
  })

  it('rejects keys with the wrong prefix without a network call', async () => {
    const result = await validateOpenAiApiKey('not-a-key')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, false)
  })
})
