import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_EXTRA_PROVIDERS,
  DEFAULT_EXTRA_PROVIDER_CONTEXT,
  extraProviderContextWindow,
  extraProviderDisplayLabel,
  extraProviderForModel,
  extraProviderModelId,
  extraProviderModelPricing,
  extraProviderPricingMap,
  isExtraProviderModel,
  resolveExtraProviders,
  toExtraProviderModel,
} from './extra-providers.ts'

describe('extra provider model encoding', () => {
  it('detects extra-provider selections by prefix, excluding reserved ones', () => {
    assert.equal(isExtraProviderModel('gemini:gemini-2.5-flash'), true)
    assert.equal(isExtraProviderModel('mistral:mistral-small-latest'), true)
    assert.equal(isExtraProviderModel('together:meta/llama-3.3'), true)
    assert.equal(isExtraProviderModel('claude-sonnet-4-6'), false)
    assert.equal(isExtraProviderModel('openrouter:openai/gpt-4o'), false)
    assert.equal(isExtraProviderModel('lmstudio:qwen'), false)
    assert.equal(isExtraProviderModel('remote-agent:cursor'), false)
  })

  it('strips the slug to the upstream id, keeping colons in the id', () => {
    assert.equal(extraProviderModelId('mistral:mistral-small-latest'), 'mistral-small-latest')
    assert.equal(extraProviderModelId('together:meta/llama:free'), 'meta/llama:free')
    assert.equal(extraProviderModelId('mistral-small-latest'), 'mistral-small-latest')
  })

  it('round-trips an upstream id through the slug', () => {
    const encoded = toExtraProviderModel('mistral', 'mistral-small-latest')
    assert.equal(encoded, 'mistral:mistral-small-latest')
    assert.equal(extraProviderModelId(encoded), 'mistral-small-latest')
  })
})

describe('extra provider lookups against a resolved list', () => {
  const providers = resolveExtraProviders([])

  it('resolves the provider that owns a model slug', () => {
    assert.equal(extraProviderForModel(providers, 'gemini:gemini-2.0-flash')?.id, 'gemini')
    assert.equal(extraProviderForModel(providers, 'deepseek:deepseek-chat')?.id, 'deepseek')
    assert.equal(extraProviderForModel(providers, 'claude-sonnet-4-6'), null)
  })

  it('labels curated models by name and falls back to the raw id', () => {
    assert.equal(
      extraProviderDisplayLabel('deepseek:deepseek-chat', providers),
      'DeepSeek V3 (deepseek-chat)',
    )
    assert.equal(
      extraProviderDisplayLabel('gemini:some-unknown-model', providers),
      'some-unknown-model',
    )
    // No list → degrade to the stripped id.
    assert.equal(extraProviderDisplayLabel('gemini:gemini-2.5-flash'), 'gemini-2.5-flash')
  })

  it('reports per-model, then per-provider fallback, context windows', () => {
    assert.equal(extraProviderContextWindow(providers, 'gemini:gemini-2.5-flash'), 1_048_576)
    // Unknown model under a known provider → provider fallback (Gemini = 1M).
    assert.equal(extraProviderContextWindow(providers, 'gemini:not-a-real-model'), 1_048_576)
    assert.equal(extraProviderContextWindow(providers, 'claude-sonnet-4-6'), null)
  })
})

describe('extra provider pricing', () => {
  const providers = resolveExtraProviders([
    {
      slug: 'huggingface',
      models: [
        {
          id: 'zai-org/GLM-5.2:together',
          label: 'zai-org/GLM-5.2',
          contextWindow: 131_072,
          inputPricePerMTok: 0.6,
          outputPricePerMTok: 2.2,
        },
        // Output rate omitted on persist → falls back to the input rate on read.
        { id: 'org/model:novita', inputPricePerMTok: 1.5 },
        { id: 'org/unpriced:x', contextWindow: 8192 },
      ],
    },
  ])

  it('round-trips stored per-model rates through resolveExtraProviders', () => {
    assert.deepEqual(extraProviderModelPricing(providers, 'huggingface:zai-org/GLM-5.2:together'), {
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
    })
  })

  it('defaults a missing output rate to the input rate', () => {
    assert.deepEqual(extraProviderModelPricing(providers, 'huggingface:org/model:novita'), {
      inputPricePerMTok: 1.5,
      outputPricePerMTok: 1.5,
    })
  })

  it('returns null for unpriced models and non-extra selections', () => {
    assert.equal(extraProviderModelPricing(providers, 'huggingface:org/unpriced:x'), null)
    assert.equal(extraProviderModelPricing(providers, 'claude-sonnet-4-6'), null)
  })

  it('builds a selection→pricing map covering only priced models', () => {
    const map = extraProviderPricingMap(providers)
    assert.deepEqual(Object.keys(map).sort(), [
      'huggingface:org/model:novita',
      'huggingface:zai-org/GLM-5.2:together',
    ])
    assert.equal(map['huggingface:zai-org/GLM-5.2:together']?.outputPricePerMTok, 2.2)
  })
})

describe('resolveExtraProviders', () => {
  it('returns the shipped presets unchanged when nothing is stored', () => {
    const providers = resolveExtraProviders(undefined)
    assert.equal(providers.length, BUILTIN_EXTRA_PROVIDERS.length)
    for (const provider of providers) {
      assert.ok(provider.builtin)
      assert.equal(provider.prefix, `${provider.id}:`)
      assert.ok(provider.baseUrl.startsWith('https://'))
      assert.ok(provider.fallbackContextWindow > 0)
    }
    assert.deepEqual(
      providers.map((p) => p.id),
      BUILTIN_EXTRA_PROVIDERS.map((p) => p.id),
    )
  })

  it('merges editable overrides onto a preset but locks label/baseUrl', () => {
    const [mistral] = resolveExtraProviders([
      {
        slug: 'mistral',
        label: 'Hacked',
        baseUrl: 'https://evil.example',
        includeUsage: false,
        fallbackContextWindow: 4096,
        models: [{ id: 'mistral-tiny', label: 'Tiny' }],
      },
    ])
    assert.ok(mistral)
    assert.equal(mistral.label, 'Mistral') // locked
    assert.equal(mistral.baseUrl, 'https://api.mistral.ai/v1') // locked
    assert.equal(mistral.includeUsage, false) // editable
    assert.equal(mistral.fallbackContextWindow, 4096) // editable
    assert.deepEqual(mistral.models, [{ id: 'mistral-tiny', label: 'Tiny' }]) // replaced
  })

  it('appends a valid user custom and defaults its context window', () => {
    const providers = resolveExtraProviders([
      { slug: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
    ])
    const together = providers.find((p) => p.id === 'together')
    assert.ok(together)
    assert.equal(together.builtin, false)
    assert.equal(together.prefix, 'together:')
    assert.equal(together.fallbackContextWindow, DEFAULT_EXTRA_PROVIDER_CONTEXT)
    assert.equal(together.envVar, undefined)
  })

  it('skips malformed customs (missing baseUrl, bad slug, dup of a preset)', () => {
    const providers = resolveExtraProviders([
      { slug: 'nourl' },
      { slug: 'Bad Slug', baseUrl: 'https://x.example' },
      { slug: 'mistral', baseUrl: 'https://api.mistral.ai/v1' }, // override, not a new provider
    ])
    assert.equal(providers.length, BUILTIN_EXTRA_PROVIDERS.length)
    assert.equal(providers.filter((p) => p.id === 'mistral').length, 1)
  })
})
