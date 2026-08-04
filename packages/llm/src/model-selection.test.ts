import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseModelSelection } from './model-selection.ts'

describe('parseModelSelection', () => {
  it('leaves a bare cloud id whole', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-4-6', 'gpt-5.6-sol']) {
      assert.deepEqual(parseModelSelection(model), {
        namespace: 'cloud',
        slug: '',
        agent: '',
        id: model,
        modelId: model,
      })
    }
  })

  it('splits an aggregator selection into slug, vendor and model', () => {
    assert.deepEqual(parseModelSelection('openrouter:anthropic/claude-opus-5'), {
      namespace: 'openrouter',
      slug: 'openrouter',
      agent: '',
      id: 'anthropic/claude-opus-5',
      modelId: 'claude-opus-5',
    })
    // A variant suffix belongs to the model id, not the routing slug.
    assert.equal(
      parseModelSelection('openrouter:z-ai/glm-4.5-air:free').modelId,
      'glm-4.5-air:free',
    )
  })

  it('keeps an LM Studio org/repo id intact', () => {
    // `org/repo` *is* the id here — dropping the leading segment would break
    // the lookup against LM Studio's own model list.
    const selection = parseModelSelection('lmstudio:qwen/qwen3-coder-30b')
    assert.equal(selection.namespace, 'lmstudio')
    assert.equal(selection.id, 'qwen/qwen3-coder-30b')
    assert.equal(selection.modelId, 'qwen/qwen3-coder-30b')
  })

  it('treats any other well-formed slug as an extra provider', () => {
    assert.deepEqual(parseModelSelection('gemini:gemini-2.5-flash'), {
      namespace: 'extra-provider',
      slug: 'gemini',
      agent: '',
      id: 'gemini-2.5-flash',
      modelId: 'gemini-2.5-flash',
    })
  })

  it('does not invent a provider from a malformed slug', () => {
    // Uppercase and punctuation are outside the slug grammar, so these stay
    // unclassified rather than becoming a provider that cannot be configured.
    for (const model of ['Gemini:foo', 'my_proxy:foo', ':leading-colon']) {
      assert.equal(parseModelSelection(model).namespace, 'cloud')
      assert.equal(parseModelSelection(model).id, model)
    }
  })

  it('splits agent-shaped selections into identity and chosen model', () => {
    assert.deepEqual(parseModelSelection('acp:cursor-agent#composer-2.5[fast=true]'), {
      namespace: 'acp',
      slug: 'acp',
      agent: 'cursor-agent',
      id: 'composer-2.5[fast=true]',
      modelId: 'composer-2.5[fast=true]',
    })
    // An agent with no model chosen leaves `id` empty rather than absent.
    assert.deepEqual(parseModelSelection('remote-agent:anthropic'), {
      namespace: 'remote-agent',
      slug: 'remote-agent',
      agent: 'anthropic',
      id: '',
      modelId: '',
    })
    assert.equal(parseModelSelection('remote-agent:cursor#claude-opus-5').id, 'claude-opus-5')
  })

  it('splits a pack route without decoding it', () => {
    // Decoding is the pack namespace's own convention, applied by its parser.
    assert.deepEqual(parseModelSelection('pack-model:my%3Apack:route-1'), {
      namespace: 'pack-model',
      slug: 'pack-model',
      agent: 'my%3Apack',
      id: 'route-1',
      modelId: 'route-1',
    })
  })

  it('classifies a reserved namespace ahead of the extra-provider grammar', () => {
    // Every reserved prefix also matches the slug grammar, so order decides.
    for (const [model, namespace] of [
      ['openrouter:x/y', 'openrouter'],
      ['lmstudio:x', 'lmstudio'],
      ['remote-agent:cursor', 'remote-agent'],
      ['acp:gemini', 'acp'],
      ['pack-model:p:r', 'pack-model'],
    ] as const) {
      assert.equal(parseModelSelection(model).namespace, namespace)
    }
  })
})
