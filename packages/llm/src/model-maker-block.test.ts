import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockedModelMaker,
  modelMakerForSelection,
  parseBlockedModelMakers,
} from './model-maker-block.ts'

describe('model maker block list', () => {
  it('recognizes xAI through every explicit route without confusing z-ai', () => {
    for (const selection of [
      'openrouter:x-ai/grok-4.5',
      'openrouter:XAI/grok-build-0.1:fast',
      'remote-agent:cursor#grok-4.3',
      'acp:cursor#grok-build-0.1',
      'lmstudio:x-ai/grok-4',
      'custom:grok-4',
      'grok-4',
    ]) {
      assert.equal(modelMakerForSelection(selection), 'xai', selection)
      assert.equal(blockedModelMaker(selection, ['xai']), 'xai', selection)
    }
    for (const selection of [
      'openrouter:z-ai/glm-5.3',
      'openrouter:openai/gpt-6-sol',
      'acp:cursor#composer-2',
      'remote-agent:cursor',
      'lmstudio:qwen/qwen3',
    ]) {
      assert.notEqual(modelMakerForSelection(selection), 'xai', selection)
    }
  })

  it('recognizes other makers across direct, aggregator, and agent routes', () => {
    assert.equal(modelMakerForSelection('openrouter:anthropic/claude-opus-5'), 'anthropic')
    assert.equal(modelMakerForSelection('remote-agent:anthropic'), 'anthropic')
    assert.equal(modelMakerForSelection('openrouter:openai/gpt-6-sol'), 'openai')
    assert.equal(modelMakerForSelection('acp:gemini#gemini-2.5-pro'), 'google')
    assert.equal(modelMakerForSelection('acp:claude-acp#opus'), 'anthropic')
    assert.equal(modelMakerForSelection('acp:claude-acp'), 'anthropic')
    assert.equal(modelMakerForSelection('huggingface:deepseek-ai/deepseek-r1'), 'deepseek')
    assert.equal(modelMakerForSelection('mistral:mistral-large-latest'), 'mistral')
  })

  it('recognizes Mistral vendor and product-family ids that do not start with mistral', () => {
    for (const selection of [
      'openrouter:mistralai/codestral-latest',
      'openrouter:mistralai/devstral-2',
      'openrouter:mistralai/magistral-medium',
      'openrouter:mistralai/ministral-3-8b',
      'openrouter:mistralai/pixtral-large-2411',
      'lmstudio:codestral-latest',
      'lmstudio:codestral',
      'acp:mistral-agent',
    ]) {
      assert.equal(modelMakerForSelection(selection), 'mistral', selection)
      assert.equal(blockedModelMaker(selection, ['mistral']), 'mistral', selection)
    }
  })

  it('does not infer a hidden model inside an agent or plugin', () => {
    assert.equal(modelMakerForSelection('acp:cursor'), null)
    assert.equal(modelMakerForSelection('remote-agent:cursor'), null)
    assert.equal(modelMakerForSelection('plugin-model:personal.reference:model'), null)
    assert.equal(modelMakerForSelection('auto:best-value'), null)
  })

  it('parses persisted settings without admitting unknown ids', () => {
    assert.deepEqual(parseBlockedModelMakers(['xai', 'unknown', 1, 'openai']), ['xai', 'openai'])
    assert.deepEqual(parseBlockedModelMakers(null), [])
  })
})
