import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENROUTER_MODELS,
  OPENROUTER_MODEL_PREFIX,
  isOpenRouterModel,
  openRouterModelId,
  toOpenRouterModel,
  openRouterDisplayLabel,
} from './openrouter.ts'

describe('openrouter model encoding', () => {
  it('detects openrouter selections by prefix', () => {
    assert.equal(isOpenRouterModel('openrouter:anthropic/claude-3.5-sonnet'), true)
    assert.equal(isOpenRouterModel('claude-sonnet-4-6'), false)
    assert.equal(isOpenRouterModel('lmstudio:qwen'), false)
  })

  it('round-trips an upstream id through the prefix', () => {
    const encoded = toOpenRouterModel('openai/gpt-4o')
    assert.equal(encoded, `${OPENROUTER_MODEL_PREFIX}openai/gpt-4o`)
    assert.equal(openRouterModelId(encoded), 'openai/gpt-4o')
  })

  it('leaves an un-prefixed id untouched when stripping', () => {
    assert.equal(openRouterModelId('openai/gpt-4o'), 'openai/gpt-4o')
  })

  it('labels curated models by name and falls back to the raw id', () => {
    assert.equal(openRouterDisplayLabel('openrouter:openai/gpt-4o'), 'GPT-4o')
    assert.equal(openRouterDisplayLabel('openrouter:some/unknown-model'), 'some/unknown-model')
  })

  it('keeps curated ids and labels non-empty', () => {
    assert.ok(OPENROUTER_MODELS.length > 0)
    for (const model of OPENROUTER_MODELS) {
      assert.ok(model.id.includes('/'), `expected vendor/model id, got ${model.id}`)
      assert.ok(model.label.length > 0)
    }
  })
})
