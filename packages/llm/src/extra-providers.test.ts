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
  isLocalBaseUrl,
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
    assert.equal(
      extraProviderForModel(providers, 'perplexity:openai/gpt-5.6-sol')?.apiStyle,
      'responses',
    )
    assert.equal(extraProviderForModel(providers, 'gemini:gemini-2.0-flash')?.id, 'gemini')
    assert.equal(extraProviderForModel(providers, 'deepseek:deepseek-chat')?.id, 'deepseek')
    assert.equal(extraProviderForModel(providers, 'claude-sonnet-4-6'), null)
  })

  it('ships Perplexity as a Responses API preset with server-side web search', () => {
    const perplexity = providers.find((provider) => provider.id === 'perplexity')
    assert.ok(perplexity)
    assert.equal(perplexity.baseUrl, 'https://api.perplexity.ai/v1')
    assert.equal(perplexity.envVar, 'PERPLEXITY_API_KEY')
    assert.deepEqual(perplexity.extraBody, {
      tools: [{ type: 'web_search' }],
      max_output_tokens: 8192,
    })
    assert.deepEqual(perplexity.models, [])
  })

  it('returns the upstream model id with the routing slug stripped', () => {
    // #1241 dropped the curated labels and meant to leave the upstream id, but
    // returned the whole selection — so the picker, transcript, and advisor all
    // rendered `deepseek:deepseek-chat` next to house-styled names. The slug is
    // the route, not the name. A known model, an unknown one, and no provider
    // list at all take the same path: `providers` is still unused.
    assert.equal(extraProviderDisplayLabel('deepseek:deepseek-chat', providers), 'deepseek-chat')
    assert.equal(
      extraProviderDisplayLabel('gemini:some-unknown-model', providers),
      'some-unknown-model',
    )
    assert.equal(extraProviderDisplayLabel('gemini:gemini-2.5-flash'), 'gemini-2.5-flash')
    // The id itself is identity: an endpoint addressed as `vendor/model:variant`
    // keeps that whole string, only the leading slug goes.
    assert.equal(
      extraProviderDisplayLabel('huggingface:zai-org/GLM-5.2:deepinfra'),
      'zai-org/GLM-5.2:deepinfra',
    )
    // A bare cloud id is not an extra-provider selection and passes through.
    assert.equal(extraProviderDisplayLabel('claude-opus-4-8'), 'claude-opus-4-8')
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
      // Hosted presets use https; local presets are IPv4-loopback http servers.
      assert.ok(
        provider.local
          ? provider.baseUrl.startsWith('http://127.0.0.1:')
          : provider.baseUrl.startsWith('https://'),
      )
      assert.equal(provider.local, isLocalBaseUrl(provider.baseUrl))
      assert.ok(provider.fallbackContextWindow > 0)
    }
    assert.deepEqual(
      providers.map((p) => p.id),
      BUILTIN_EXTRA_PROVIDERS.map((p) => p.id),
    )
  })

  it('merges editable overrides onto a preset but locks label/baseUrl', () => {
    const mistral = resolveExtraProviders([
      {
        slug: 'mistral',
        label: 'Hacked',
        baseUrl: 'https://evil.example',
        includeUsage: false,
        fallbackContextWindow: 4096,
        models: [{ id: 'mistral-tiny' }],
      },
    ]).find((provider) => provider.id === 'mistral')
    assert.ok(mistral)
    assert.equal(mistral.label, 'Mistral') // locked
    assert.equal(mistral.baseUrl, 'https://api.mistral.ai/v1') // locked
    assert.equal(mistral.includeUsage, false) // editable
    assert.equal(mistral.fallbackContextWindow, 4096) // editable
    assert.deepEqual(mistral.models, [{ id: 'mistral-tiny' }]) // replaced
  })

  it('appends a valid user custom and defaults its context window', () => {
    const providers = resolveExtraProviders([
      { slug: 'acme', label: 'Acme AI', baseUrl: 'https://api.acme.example/v1' },
    ])
    const acme = providers.find((p) => p.id === 'acme')
    assert.ok(acme)
    assert.equal(acme.builtin, false)
    assert.equal(acme.prefix, 'acme:')
    assert.equal(acme.fallbackContextWindow, DEFAULT_EXTRA_PROVIDER_CONTEXT)
    assert.equal(acme.envVar, undefined)
  })

  it('promotes a formerly custom ZDR endpoint without losing its editable overrides', () => {
    const providers = resolveExtraProviders([
      {
        slug: 'groq',
        label: 'Groq custom',
        baseUrl: 'https://api.groq.com/openai/v1',
        models: [{ id: 'llama-custom' }],
        fallbackContextWindow: 32_768,
      },
    ])
    const groq = providers.find((p) => p.id === 'groq')
    assert.ok(groq)
    assert.equal(groq.builtin, true)
    assert.equal(groq.label, 'Groq')
    assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1')
    assert.deepEqual(groq.models, [{ id: 'llama-custom' }])
    assert.equal(groq.fallbackContextWindow, 32_768)
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

  it('drops customs with an unsafe base URL so a tampered settings.json cannot leak the key', () => {
    const providers = resolveExtraProviders([
      { slug: 'plainhttp', baseUrl: 'http://attacker.example/v1' }, // http to a non-loopback host
      { slug: 'metadata', baseUrl: 'http://169.254.169.254/latest' }, // link-local metadata over http
      { slug: 'httpsmeta', baseUrl: 'https://169.254.169.254/latest' }, // link-local metadata over https
      { slug: 'httpslan', baseUrl: 'https://192.168.1.5/v1' }, // private LAN address over https
      { slug: 'userinfo', baseUrl: 'https://user:pass@evil.example/v1' }, // embedded credentials
      { slug: 'safehttps', baseUrl: 'https://api.together.xyz/v1' }, // safe → kept
      { slug: 'safelocal', baseUrl: 'http://localhost:1234/v1' }, // loopback http → kept
    ])
    const ids = providers.map((p) => p.id)
    assert.ok(!ids.includes('plainhttp'))
    assert.ok(!ids.includes('metadata'))
    assert.ok(!ids.includes('httpsmeta'))
    assert.ok(!ids.includes('httpslan'))
    assert.ok(!ids.includes('userinfo'))
    assert.ok(ids.includes('safehttps'))
    assert.ok(ids.includes('safelocal'))
  })
})

describe('local providers', () => {
  it('classifies loopback base URLs as local', () => {
    assert.equal(isLocalBaseUrl('http://localhost:11434/v1'), true)
    assert.equal(isLocalBaseUrl('http://127.0.0.1:8080/v1'), true)
    assert.equal(isLocalBaseUrl('http://[::1]:1234/v1'), true)
    assert.equal(isLocalBaseUrl('http://api.localhost/v1'), true)
    assert.equal(isLocalBaseUrl('https://api.mistral.ai/v1'), false)
    assert.equal(isLocalBaseUrl('not a url'), false)
  })

  it('treats the full 127.0.0.0/8 range and unspecified bind addresses as local', () => {
    // Rest of the loopback /8 range (not just 127.0.0.1).
    assert.equal(isLocalBaseUrl('http://127.0.1.1:8000/v1'), true)
    assert.equal(isLocalBaseUrl('http://127.255.255.254:8080/v1'), true)
    // Common vLLM/llama.cpp bind-all addresses.
    assert.equal(isLocalBaseUrl('http://0.0.0.0:8000/v1'), true)
    assert.equal(isLocalBaseUrl('http://[::]:8000/v1'), true)
    // Non-loopback addresses stay cloud.
    assert.equal(isLocalBaseUrl('http://128.0.0.1:8000/v1'), false)
    assert.equal(isLocalBaseUrl('http://192.168.1.5:8000/v1'), false)
  })

  it('only unwraps a properly-bracketed IPv6 literal', () => {
    // A matched-bracket form is unwrapped and recognised…
    assert.equal(isLocalBaseUrl('http://[::1]/v1'), true)
    // …while a host the URL parser can still resolve but that does not match a
    // loopback literal is cloud. (Mismatched brackets are rejected by the URL
    // parser itself, so they degrade to `false` via the catch.)
    assert.equal(isLocalBaseUrl('http://[::1/v1'), false)
  })

  it('ships the local server presets flagged local with empty model lists', () => {
    const providers = resolveExtraProviders(undefined)
    for (const slug of ['ollama', 'llamacpp', 'jan', 'vllm']) {
      const provider = providers.find((p) => p.id === slug)
      assert.ok(provider, `missing local preset ${slug}`)
      assert.equal(provider.local, true)
      assert.equal(provider.builtin, true)
      assert.equal(provider.models.length, 0)
    }
  })

  it('marks a user-added loopback custom as local', () => {
    const [custom] = resolveExtraProviders([
      { slug: 'myllm', label: 'My LLM', baseUrl: 'http://127.0.0.1:9999/v1' },
    ]).filter((p) => p.id === 'myllm')
    assert.ok(custom)
    assert.equal(custom.local, true)
  })
})
