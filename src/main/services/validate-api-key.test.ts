import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAnthropicApiKey,
  validateExtraProviderApiKey,
  validateOpenAiApiKey,
  validateOpenRouterApiKey,
} from './validate-api-key.ts'
import { BUILTIN_EXTRA_PROVIDERS, type ExtraProvider } from '@shared/llm/extra-providers.ts'

const PRESET = (slug: string): ExtraProvider => BUILTIN_EXTRA_PROVIDERS.find((p) => p.id === slug)!

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

describe('validateOpenRouterApiKey', () => {
  it('rejects empty keys', async () => {
    const result = await validateOpenRouterApiKey('   ')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, undefined)
  })

  it('rejects keys without the sk-or- prefix without a network call', async () => {
    const result = await validateOpenRouterApiKey('sk-1234')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, false)
  })
})

describe('validateExtraProviderApiKey', () => {
  it('rejects empty keys', async () => {
    const result = await validateExtraProviderApiKey(PRESET('mistral'), '   ')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, undefined)
  })

  it('rejects a Gemini key with the wrong prefix without a network call', async () => {
    const result = await validateExtraProviderApiKey(PRESET('gemini'), 'not-a-google-key')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, false)
    assert.match(result.error ?? '', /AIza/)
  })

  it('rejects a DeepSeek key with the wrong prefix without a network call', async () => {
    const result = await validateExtraProviderApiKey(PRESET('deepseek'), 'dk-1234')
    assert.equal(result.ok, false)
    assert.equal(result.formatOk, false)
  })

  it('accepts Mistral keys regardless of shape (no fixed prefix) and reaches the network', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (): Promise<Response> =>
      ({ ok: true, status: 200, statusText: 'OK' }) as Response
    try {
      const result = await validateExtraProviderApiKey(PRESET('mistral'), 'any-shaped-key')
      assert.equal(result.ok, true)
      assert.equal(result.formatOk, true)
    } finally {
      globalThis.fetch = original
    }
  })
})
