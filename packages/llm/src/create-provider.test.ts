import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { APP_ATTRIBUTION_TITLE, APP_ATTRIBUTION_URL } from './app-attribution.ts'
import { anthropicMaxOutputTokens, getModelInfo } from './model-catalog.ts'
import { isRetryableStreamError, streamRetryDelayMs } from './stream-retry.ts'
import { SERVICE_TIERS } from './service-tier.ts'
import type { LLMProvider } from './wire-types.ts'
import {
  createExtraCloudProvider,
  createLocalOpenAIProvider,
  createOpenRouterProvider,
  createProvider,
} from './create-provider.ts'
import { BUILTIN_EXTRA_PROVIDERS } from './extra-providers.ts'
import { OpenAIProvider } from './openai-provider.ts'
import type { ExtraProvider } from './extra-providers.ts'
import { ResponsesProvider } from './responses-provider.ts'

describe('anthropicMaxOutputTokens', () => {
  it('uses per-model catalog metadata', () => {
    assert.equal(
      anthropicMaxOutputTokens('claude-sonnet-4-6'),
      getModelInfo('claude-sonnet-4-6')?.maxOutputTokens,
    )
  })

  it('defaults unknown models to 8192', () => {
    assert.equal(anthropicMaxOutputTokens('claude-unknown'), 8192)
  })
})

describe('isRetryableStreamError', () => {
  it('retries rate limits and connection errors', () => {
    assert.equal(
      isRetryableStreamError(
        new Anthropic.RateLimitError(429, {}, 'rate limit', new Headers({ 'retry-after': '2' })),
      ),
      true,
    )
    assert.equal(isRetryableStreamError(new Anthropic.APIConnectionError({})), true)
  })

  it('does not retry auth or user abort', () => {
    assert.equal(
      isRetryableStreamError(new Anthropic.AuthenticationError(401, {}, 'auth', new Headers())),
      false,
    )
    assert.equal(isRetryableStreamError(new Anthropic.APIUserAbortError()), false)
  })
})

describe('streamRetryDelayMs', () => {
  it('honors retry-after seconds', () => {
    const err = new Anthropic.RateLimitError(
      429,
      {},
      'rate limit',
      new Headers({ 'retry-after': '3' }),
    )
    assert.equal(streamRetryDelayMs(err, 0), 3000)
  })
})

describe('createProvider routing', () => {
  it('fails fast for gpt-* when OpenAI key is missing', () => {
    const prevMock = process.env['COPSE_PANEL_MOCK_LLM']
    const prevAnthropic = process.env['ANTHROPIC_API_KEY']
    const prevOpenai = process.env['OPENAI_API_KEY']
    delete process.env['COPSE_PANEL_MOCK_LLM']
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic'
    delete process.env['OPENAI_API_KEY']
    try {
      assert.throws(
        () => createProvider('gpt-4o', { anthropicApiKey: 'test-anthropic', openAiApiKey: null }),
        /OpenAI is not configured/,
      )
    } finally {
      if (prevMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = prevMock
      if (prevAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prevAnthropic
      if (prevOpenai === undefined) delete process.env['OPENAI_API_KEY']
      else process.env['OPENAI_API_KEY'] = prevOpenai
    }
  })
})

interface CapturedRequestBody {
  prompt_cache_key?: string
  service_tier?: string
  store?: boolean
  provider?: { require_parameters?: boolean; zdr?: boolean; data_collection?: string }
  stream_options?: { include_usage?: boolean }
  reasoning?: { effort?: string; enabled?: boolean }
  reasoning_effort?: string
  temperature?: number
  top_p?: number
  max_tokens?: number
}

function expectOpenAIProvider(provider: LLMProvider): OpenAIProvider {
  assert.ok(provider instanceof OpenAIProvider)
  return provider
}

// Capture the request body a provider sends by stubbing its private OpenAI client.
async function captureRequest(provider: OpenAIProvider): Promise<CapturedRequestBody> {
  const captured: { request?: CapturedRequestBody } = {}
  const create = (
    request: CapturedRequestBody,
  ): AsyncIterable<{
    choices: Array<{ delta?: { content?: string }; finish_reason?: string }>
  }> => {
    captured.request = request
    return (async function* (): AsyncGenerator<{
      choices: Array<{ delta?: { content?: string }; finish_reason?: string }>
    }> {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
    })()
  }
  Object.defineProperty(provider, 'client', {
    value: { chat: { completions: { create } } },
    configurable: true,
  })
  for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], [])) void _
  return captured.request ?? {}
}

// The attribution headers are handed to the SDK client at construction, so they
// are read back from the client's stored options rather than from a request
// body. `_options` is the SDK's own record of what it was configured with.
function clientDefaultHeader(provider: LLMProvider, name: string): unknown {
  const client: unknown = Reflect.get(provider, 'client')
  assert.ok(client !== null && typeof client === 'object')
  const options: unknown = Reflect.get(client, '_options')
  assert.ok(options !== null && typeof options === 'object')
  const headers: unknown = Reflect.get(options, 'defaultHeaders')
  assert.ok(headers !== null && typeof headers === 'object')
  return Reflect.get(headers, name)
}

describe('app attribution headers', () => {
  it('identifies Copse to direct Anthropic and OpenAI', () => {
    for (const provider of [
      createProvider('claude-sonnet-4-6', { anthropicApiKey: 'sk-ant-test' }),
      createProvider('gpt-4o', { openAiApiKey: 'sk-test' }),
    ]) {
      assert.equal(clientDefaultHeader(provider, 'HTTP-Referer'), APP_ATTRIBUTION_URL)
      assert.equal(clientDefaultHeader(provider, 'X-Title'), APP_ATTRIBUTION_TITLE)
    }
  })

  it('identifies Copse to local and custom OpenAI-compatible servers', () => {
    const local = createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen-local')
    assert.equal(clientDefaultHeader(local, 'X-Title'), APP_ATTRIBUTION_TITLE)

    const provider: ExtraProvider = {
      id: 'acme',
      label: 'Acme',
      prefix: 'acme:',
      baseUrl: 'https://api.acme.example/v1',
      builtin: false,
      local: false,
      keyLabel: 'Key',
      keyPlaceholder: '…',
      keyHint: '',
      fallbackContextWindow: 128_000,
      models: [],
    }
    const custom = createExtraCloudProvider(provider, 'some-model', 'key', ['api.acme.example'])
    assert.equal(clientDefaultHeader(custom, 'X-Title'), APP_ATTRIBUTION_TITLE)
  })

  it('identifies Copse on the Responses transport too', () => {
    const preset = BUILTIN_EXTRA_PROVIDERS.find((p) => p.apiStyle === 'responses')
    assert.ok(preset)
    const responses = createExtraCloudProvider(preset, 'sonar', 'key')
    assert.equal(clientDefaultHeader(responses, 'HTTP-Referer'), APP_ATTRIBUTION_URL)
    assert.equal(clientDefaultHeader(responses, 'X-Title'), APP_ATTRIBUTION_TITLE)
  })

  it('sends both OpenRouter title header names with one value', () => {
    const router = createOpenRouterProvider('openai/gpt-4o', 'sk-or-test')
    assert.equal(clientDefaultHeader(router, 'HTTP-Referer'), APP_ATTRIBUTION_URL)
    assert.equal(clientDefaultHeader(router, 'X-Title'), APP_ATTRIBUTION_TITLE)
    assert.equal(clientDefaultHeader(router, 'X-OpenRouter-Title'), APP_ATTRIBUTION_TITLE)
  })
})

describe('createProvider prompt cache key', () => {
  it('threads promptCacheKey into the OpenAI request body', async () => {
    const provider = expectOpenAIProvider(
      createProvider('gpt-4o', { openAiApiKey: 'test-openai' }, 'thread-xyz'),
    )
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, 'thread-xyz')
  })

  it('threads promptCacheKey into the OpenRouter request body', async () => {
    const provider = expectOpenAIProvider(
      createOpenRouterProvider('openai/gpt-4o', 'sk-or-test', 'thread-xyz'),
    )
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, 'thread-xyz')
  })

  it('omits prompt_cache_key when no key is supplied', async () => {
    const provider = expectOpenAIProvider(createProvider('gpt-4o', { openAiApiKey: 'test-openai' }))
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, undefined)
  })
})

describe('createProvider service tier', () => {
  it('sends service_tier on the chat-completions transport', async () => {
    // gpt-4o is not reasoning-capable, so it stays on /v1/chat/completions.
    const provider = expectOpenAIProvider(
      createProvider('gpt-4o', { openAiApiKey: 'test-openai' }, undefined, {
        serviceTier: 'flex',
      }),
    )
    const request = await captureRequest(provider)
    assert.equal(request.service_tier, 'flex')
  })

  it('omits service_tier entirely by default, keeping standard processing', async () => {
    const provider = expectOpenAIProvider(createProvider('gpt-4o', { openAiApiKey: 'test-openai' }))
    const request = await captureRequest(provider)
    assert.equal(request.service_tier, undefined)
  })

  it('sends each documented tier unchanged', async () => {
    // The tier set is pinned (see service-tier.ts): `SERVICE_TIERS` matches
    // OpenAI's documented values exactly, so an unrecognised tier is refused at
    // the settings boundary rather than forwarded for the API to 400 on.
    for (const tier of SERVICE_TIERS) {
      // gpt-4o, not a reasoning model: this case is about the tier value
      // surviving verbatim, and gpt-5.6-sol now routes to /v1/responses (see
      // the Responses case below), where `expectOpenAIProvider` would fail.
      const provider = expectOpenAIProvider(
        createProvider('gpt-4o', { openAiApiKey: 'test-openai' }, undefined, {
          serviceTier: tier,
        }),
      )
      const request = await captureRequest(provider)
      assert.equal(request.service_tier, tier)
    }
  })

  it('carries the tier onto the Responses transport too', async () => {
    // The tier is a billing choice, not a transport detail: routing a
    // reasoning model to /v1/responses must not silently drop it.
    const provider = createProvider('gpt-5.6-sol', { openAiApiKey: 'test-openai' }, undefined, {
      serviceTier: 'flex',
    })
    assert.ok(provider instanceof ResponsesProvider)
    const captured: { request?: { service_tier?: string } } = {}
    Object.defineProperty(provider, 'client', {
      value: {
        responses: {
          create: (request: {
            service_tier?: string
          }): AsyncIterable<{ type: string; delta: string }> => {
            captured.request = request
            return oneTextDelta()
          },
        },
      },
      configurable: true,
    })
    for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], [])) void _
    assert.equal(captured.request?.service_tier, 'flex')
  })

  it('keeps the store opt-out alongside the tier', async () => {
    // service_tier must not displace the privacy default.
    const provider = expectOpenAIProvider(
      createProvider('gpt-4o', { openAiApiKey: 'test-openai' }, 'thread-1', {
        serviceTier: 'priority',
      }),
    )
    const request = await captureRequest(provider)
    assert.equal(request.service_tier, 'priority')
    assert.equal(request.store, false)
    assert.equal(request.prompt_cache_key, 'thread-1')
  })

  it('never sends service_tier to Anthropic, which rejects unknown fields', () => {
    const provider = createProvider(
      'claude-sonnet-4-6',
      { anthropicApiKey: 'sk-ant-test' },
      undefined,
      {
        serviceTier: 'flex',
      },
    )
    // Routed to the Anthropic adapter, which has no service-tier concept at all.
    assert.ok(!(provider instanceof OpenAIProvider))
  })
})

describe('provider data-retention request defaults', () => {
  it('sends store:false to direct OpenAI so responses are not retained as app state', async () => {
    const provider = expectOpenAIProvider(createProvider('gpt-4o', { openAiApiKey: 'test-openai' }))
    const request = await captureRequest(provider)
    assert.equal(request.store, false)
  })

  it('does not send store to OpenAI-compatible local servers', async () => {
    const provider = expectOpenAIProvider(
      createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen-local'),
    )
    const request = await captureRequest(provider)
    assert.equal(request.store, undefined)
  })

  it('requests ZDR-only, non-training OpenRouter routing by default', async () => {
    const provider = expectOpenAIProvider(createOpenRouterProvider('openai/gpt-4o', 'sk-or-test'))
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, {
      require_parameters: true,
      zdr: true,
      data_collection: 'deny',
    })
  })

  it('keeps the training exclusion when only zdrOnly is turned off', async () => {
    const provider = expectOpenAIProvider(
      createOpenRouterProvider('openai/gpt-4o', 'sk-or-test', undefined, {
        zdrOnly: false,
      }),
    )
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, { require_parameters: true, data_collection: 'deny' })
  })

  it('drops data_collection only with the explicit allowTraining opt-in', async () => {
    const provider = expectOpenAIProvider(
      createOpenRouterProvider('openai/gpt-4o', 'sk-or-test', undefined, {
        zdrOnly: false,
        allowTraining: true,
      }),
    )
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, { require_parameters: true })
  })
})

describe('createLocalOpenAIProvider', () => {
  it('requests streamed usage so local models populate the usage ledger', async () => {
    const provider = expectOpenAIProvider(
      createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen/qwen3.6-35b-a3b'),
    )
    const request = await captureRequest(provider)
    assert.equal(request.stream_options?.include_usage, true)
  })
})

describe('createExtraCloudProvider host allowlist', () => {
  const custom: ExtraProvider = {
    id: 'acme',
    label: 'Acme',
    prefix: 'acme:',
    baseUrl: 'https://api.acme.example/v1',
    builtin: false,
    local: false,
    keyLabel: 'Key',
    keyPlaceholder: '…',
    keyHint: '',
    fallbackContextWindow: 128_000,
    models: [],
  }

  it('constructs when the custom host is approved', () => {
    const provider = createExtraCloudProvider(custom, 'model', 'sk-test', ['api.acme.example'])
    assert.ok(provider instanceof OpenAIProvider)
  })

  it('throws before constructing when the custom host is not approved', () => {
    assert.throws(() => {
      createExtraCloudProvider(custom, 'model', 'sk-test', [])
    }, /not approved/)
  })

  it('rejects plaintext custom providers even when their host is approved', () => {
    assert.throws(
      () =>
        createExtraCloudProvider(
          { ...custom, baseUrl: 'http://api.acme.example/v1' },
          'model',
          'sk-test',
          ['api.acme.example'],
        ),
      /only use http: for loopback hosts/,
    )
  })

  it('allows a local provider without approval', () => {
    const local: ExtraProvider = {
      ...custom,
      id: 'ollama',
      prefix: 'ollama:',
      baseUrl: 'http://localhost:11434/v1',
      builtin: true,
      local: true,
    }
    assert.doesNotThrow(() => {
      createExtraCloudProvider(local, 'llama', '', [])
    })
  })
})

/** Shortest stream that lets a Responses `provider.stream()` run to completion. */
async function* oneTextDelta(): AsyncIterable<{ type: string; delta: string }> {
  yield { type: 'response.output_text.delta', delta: 'ok' }
}

describe('createExtraCloudProvider Responses transport', () => {
  it('uses the Responses transport for the Perplexity Agent API preset', () => {
    const perplexity = BUILTIN_EXTRA_PROVIDERS.find((provider) => provider.id === 'perplexity')
    assert.ok(perplexity)

    const provider = createExtraCloudProvider(perplexity, 'openai/gpt-5.6-sol', 'pplx-test')

    assert.ok(provider instanceof ResponsesProvider)
  })

  /** Shortest stream that lets `provider.stream()` run to completion. */
  async function* oneTextDelta(): AsyncIterable<{ type: string; delta: string }> {
    yield { type: 'response.output_text.delta', delta: 'ok' }
  }

  /** The `tools` array that reaches the Responses request for a configured provider. */
  async function requestedTools(configuredTools: unknown): Promise<readonly unknown[]> {
    const responsesProvider: ExtraProvider = {
      id: 'acme',
      label: 'Acme',
      prefix: 'acme:',
      baseUrl: 'https://api.acme.example/v1',
      apiStyle: 'responses',
      builtin: false,
      local: false,
      keyLabel: 'Key',
      keyPlaceholder: '…',
      keyHint: '',
      fallbackContextWindow: 128_000,
      extraBody: { tools: configuredTools },
      models: [],
    }
    const provider = createExtraCloudProvider(responsesProvider, 'some-model', 'key', [
      'api.acme.example',
    ])
    const captured: { tools?: readonly unknown[] | undefined } = {}
    Object.defineProperty(provider, 'client', {
      value: {
        responses: {
          create: (request: {
            tools?: readonly unknown[]
          }): AsyncIterable<{ type: string; delta: string }> => {
            captured.tools = request.tools
            return oneTextDelta()
          },
        },
      },
      configurable: true,
    })
    for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], [])) {
      // drain
    }
    const { tools: sent } = captured
    assert.ok(sent, 'the provider should have issued a request')
    return sent
  }

  it('forwards server-side tools other than web_search instead of dropping them', async () => {
    // The previous allowlist kept only `web_search`, so a user who configured
    // CodeInterpreter got no tool and no error — the request simply went out
    // without it. Anything the provider executes itself must survive.
    assert.deepEqual(
      await requestedTools([
        { type: 'web_search' },
        { type: 'code_interpreter', container: { type: 'auto' } },
        { type: 'image_generation' },
      ]),
      [
        { type: 'web_search' },
        { type: 'code_interpreter', container: { type: 'auto' } },
        { type: 'image_generation' },
      ],
    )
  })

  it('forwards a provider-specific server tool spec it has never seen', async () => {
    // e.g. OpenRouter's own web-search shape. An allowlist cannot enumerate
    // these; an unknown type belongs to the provider to accept or reject.
    assert.deepEqual(
      await requestedTools([{ type: 'web_search_preview', search_context: 'high' }]),
      [{ type: 'web_search_preview', search_context: 'high' }],
    )
  })

  it('refuses a function tool smuggled in through provider config', async () => {
    // Function tools come from Copse's registry and have implementations behind
    // them. One injected here would be advertised with nothing able to run it.
    assert.deepEqual(
      await requestedTools([
        { type: 'function', name: 'rm_rf', parameters: {} },
        { type: 'web_search' },
      ]),
      [{ type: 'web_search' }],
    )
  })

  it('ignores malformed tools entries without failing the request', async () => {
    assert.deepEqual(await requestedTools([null, 'web_search', 42, {}, { type: 'web_search' }]), [
      { type: 'web_search' },
    ])
  })
})

describe('tuned model parameters reach the provider', () => {
  it('sends OpenRouter reasoning on its unified field, not the alias', async () => {
    const provider = expectOpenAIProvider(
      createOpenRouterProvider('deepseek/deepseek-v4-flash', 'sk-or-test', undefined, {
        params: { reasoning: 'max', temperature: 1, topP: 0.95 },
      }),
    )
    const request = await captureRequest(provider)
    assert.deepEqual(request.reasoning, { effort: 'max' })
    assert.equal(request.reasoning_effort, undefined)
    assert.equal(request.temperature, 1)
    assert.equal(request.top_p, 0.95)
  })

  it('expresses OpenRouter "off" as disabled reasoning', async () => {
    const provider = expectOpenAIProvider(
      createOpenRouterProvider('deepseek/deepseek-v4-flash', 'sk-or-test', undefined, {
        params: { reasoning: 'off' },
      }),
    )
    const request = await captureRequest(provider)
    assert.deepEqual(request.reasoning, { enabled: false })
  })

  it('sends reasoning_effort to a local OpenAI-compatible server', async () => {
    const provider = expectOpenAIProvider(
      createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen-local', 'lm-studio', {
        reasoning: 'high',
        temperature: 0.6,
      }),
    )
    const request = await captureRequest(provider)
    assert.equal(request.reasoning_effort, 'high')
    assert.equal(request.temperature, 0.6)
  })

  it('leaves an untuned request body untouched', async () => {
    const provider = expectOpenAIProvider(
      createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen-local'),
    )
    const request = await captureRequest(provider)
    assert.equal(request.reasoning_effort, undefined)
    assert.equal(request.temperature, undefined)
    assert.equal(request.top_p, undefined)
    assert.equal(request.reasoning, undefined)
    assert.equal(request.max_tokens, undefined)
  })
})

describe('published output ceilings', () => {
  it('sends the card’s ceiling once reasoning reaches the level it names', async () => {
    const request = await captureRequest(
      expectOpenAIProvider(
        createLocalOpenAIProvider(
          'http://localhost:1234/v1',
          'deepseek-v4-flash-0731',
          'lm-studio',
          {
            reasoning: 'max',
          },
        ),
      ),
    )
    assert.equal(request.max_tokens, 384_000)
  })

  it('sends it on OpenRouter too, where the level rides a different field', async () => {
    const request = await captureRequest(
      expectOpenAIProvider(
        createOpenRouterProvider('deepseek/deepseek-v4-flash-0731', 'sk-or-test', undefined, {
          params: { reasoning: 'high' },
        }),
      ),
    )
    assert.deepEqual(request.reasoning, { effort: 'high' })
    assert.equal(request.max_tokens, 384_000)
  })

  it('stays out of the body at a shallower level', async () => {
    const request = await captureRequest(
      expectOpenAIProvider(
        createLocalOpenAIProvider(
          'http://localhost:1234/v1',
          'deepseek-v4-flash-0731',
          'lm-studio',
          {
            reasoning: 'medium',
          },
        ),
      ),
    )
    assert.equal(request.max_tokens, undefined)
  })

  it('stays out of the body for a model we hold no card for', async () => {
    const request = await captureRequest(
      expectOpenAIProvider(
        createLocalOpenAIProvider('http://localhost:1234/v1', 'qwen-local', 'lm-studio', {
          reasoning: 'max',
        }),
      ),
    )
    assert.equal(request.max_tokens, undefined)
  })
})

describe('createProvider OpenAI transport routing', () => {
  it('sends reasoning-capable OpenAI models over the Responses API', () => {
    for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.5', 'gpt-5.6-sol']) {
      const provider = createProvider(model, { openAiApiKey: 'sk-test' })
      assert.ok(provider instanceof ResponsesProvider, model)
    }
  })

  it('keeps non-reasoning OpenAI models on chat completions', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini']) {
      const provider = createProvider(model, { openAiApiKey: 'sk-test' })
      assert.ok(provider instanceof OpenAIProvider, model)
    }
  })

  it('pins back to chat completions when forceChatCompletions is set', () => {
    // The escape hatch, mirroring llm's `-o chat_completions 1`.
    const provider = createProvider('gpt-5.6-sol', { openAiApiKey: 'sk-test' }, undefined, {
      forceChatCompletions: true,
    })
    assert.ok(provider instanceof OpenAIProvider)
  })

  it('keeps the store opt-out and cache key on the Responses transport', async () => {
    // Switching transport must not quietly drop the privacy default (#store)
    // or the per-thread cache hint.
    const provider = createProvider('gpt-5.6-sol', { openAiApiKey: 'sk-test' }, 'thread-abc')
    assert.ok(provider instanceof ResponsesProvider)
    const captured: { request?: { store?: boolean; prompt_cache_key?: string } } = {}
    Object.defineProperty(provider, 'client', {
      value: {
        responses: {
          create: (request: {
            store?: boolean
            prompt_cache_key?: string
          }): AsyncIterable<{ type: string; delta: string }> => {
            captured.request = request
            return oneTextDelta()
          },
        },
      },
      configurable: true,
    })
    for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], [])) void _

    const { request } = captured
    assert.ok(request, 'the provider should have issued a request')
    assert.equal(request.store, false)
    assert.equal(request.prompt_cache_key, 'thread-abc')
  })

  it('never routes an OpenRouter-hosted OpenAI model to the first-party transport', () => {
    // OpenRouter serves its own endpoint; it must stay on the aggregator path.
    const provider = createOpenRouterProvider('openai/gpt-5.6-sol', 'sk-or-test')
    assert.ok(provider instanceof OpenAIProvider)
  })
})
