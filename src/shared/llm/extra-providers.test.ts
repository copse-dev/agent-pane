import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTRA_PROVIDERS,
  EXTRA_PROVIDERS_LIST,
  extraProviderContextWindow,
  extraProviderDisplayLabel,
  extraProviderForModel,
  extraProviderModelId,
  isExtraProviderModel,
  toExtraProviderModel,
} from './extra-providers.ts'

describe('extra provider model encoding', () => {
  it('detects extra-provider selections by prefix', () => {
    assert.equal(isExtraProviderModel('gemini:gemini-2.5-flash'), true)
    assert.equal(isExtraProviderModel('mistral:mistral-small-latest'), true)
    assert.equal(isExtraProviderModel('deepseek:deepseek-chat'), true)
    assert.equal(isExtraProviderModel('claude-sonnet-4-6'), false)
    assert.equal(isExtraProviderModel('openrouter:openai/gpt-4o'), false)
    assert.equal(isExtraProviderModel('lmstudio:qwen'), false)
  })

  it('resolves the provider that owns a model prefix', () => {
    assert.equal(extraProviderForModel('gemini:gemini-2.0-flash')?.id, 'gemini')
    assert.equal(extraProviderForModel('deepseek:deepseek-chat')?.id, 'deepseek')
    assert.equal(extraProviderForModel('claude-sonnet-4-6'), null)
  })

  it('round-trips an upstream id through the prefix', () => {
    const encoded = toExtraProviderModel('mistral', 'mistral-small-latest')
    assert.equal(encoded, 'mistral:mistral-small-latest')
    assert.equal(extraProviderModelId(encoded), 'mistral-small-latest')
  })

  it('leaves an un-prefixed id untouched when stripping', () => {
    assert.equal(extraProviderModelId('mistral-small-latest'), 'mistral-small-latest')
  })

  it('labels curated models by name and falls back to the raw id', () => {
    assert.equal(extraProviderDisplayLabel('deepseek:deepseek-chat'), 'DeepSeek V3 (deepseek-chat)')
    assert.equal(extraProviderDisplayLabel('gemini:some-unknown-model'), 'some-unknown-model')
  })

  it('reports the context window for a curated model, null otherwise', () => {
    assert.equal(extraProviderContextWindow('gemini:gemini-2.5-flash'), 1_048_576)
    assert.equal(extraProviderContextWindow('gemini:not-a-real-model'), null)
    assert.equal(extraProviderContextWindow('claude-sonnet-4-6'), null)
  })

  it('keeps every provider id, prefix, and model shortlist well-formed', () => {
    assert.ok(EXTRA_PROVIDERS_LIST.length === 3)
    for (const provider of EXTRA_PROVIDERS_LIST) {
      assert.equal(provider, EXTRA_PROVIDERS[provider.id])
      assert.equal(provider.prefix, `${provider.id}:`)
      assert.ok(provider.baseUrl.startsWith('https://'))
      assert.ok(provider.models.length > 0)
      for (const model of provider.models) {
        assert.ok(model.id.length > 0)
        assert.ok(model.label.length > 0)
        assert.ok(model.contextWindow > 0)
      }
    }
  })
})
