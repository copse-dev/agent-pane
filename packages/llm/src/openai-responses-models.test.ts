import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { usesResponsesApi } from './openai-responses-models.ts'
import { TRACKED_MODELS } from './model-catalog.ts'

describe('usesResponsesApi', () => {
  it('routes the reasoning-capable OpenAI families', () => {
    for (const model of [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.5',
      'gpt-5.6-sol',
      'o1',
      'o3-mini',
      'o4-mini',
    ]) {
      assert.equal(usesResponsesApi(model), true, model)
    }
  })

  it('leaves non-reasoning models on chat completions', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
      assert.equal(usesResponsesApi(model), false, model)
    }
  })

  it('resolves dated snapshots of a routed family', () => {
    assert.equal(usesResponsesApi('gpt-5.6-sol-2026-07-01'), true)
    assert.equal(usesResponsesApi('gpt-5-2025-08-07'), true)
    assert.equal(usesResponsesApi('o3-2025-04-16'), true)
  })

  it('does not match a different family that merely starts with the same letters', () => {
    // `o1` must not swallow an unrelated `o1x`-style id, and `gpt-50` is not gpt-5.
    assert.equal(usesResponsesApi('o1x-turbo'), false)
    assert.equal(usesResponsesApi('gpt-50'), false)
    assert.equal(usesResponsesApi('gpt-5x'), false)
  })

  it('ignores namespaced selections, which pick their own transport', () => {
    // OpenRouter and extra providers reach OpenAI models by their own routing;
    // catching them here would switch a transport their endpoint may not serve.
    assert.equal(usesResponsesApi('openrouter:openai/gpt-5'), false)
    assert.equal(usesResponsesApi('perplexity:gpt-5.6-sol'), false)
    assert.equal(usesResponsesApi('lmstudio:gpt-5-clone'), false)
  })

  it('classifies every tracked OpenAI model without throwing', () => {
    // Guards against a future catalog entry landing in neither bucket by accident.
    for (const model of TRACKED_MODELS.filter((id) => id.startsWith('gpt'))) {
      assert.equal(typeof usesResponsesApi(model), 'boolean', model)
    }
  })
})
