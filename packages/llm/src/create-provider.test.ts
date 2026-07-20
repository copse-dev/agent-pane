import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { anthropicMaxOutputTokens, getModelInfo } from './model-catalog.ts'
import { isRetryableStreamError, streamRetryDelayMs } from './stream-retry.ts'
import type { ProviderStreamChunk } from './wire-types.ts'
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
  store?: boolean
  provider?: { require_parameters?: boolean; zdr?: boolean; data_collection?: string }
}

// Capture the request body a provider sends by stubbing its private OpenAI client.
async function captureRequest(provider: OpenAIProvider): Promise<CapturedRequestBody> {
  const captured: { request?: CapturedRequestBody } = {}
  ;(
    provider as unknown as {
      client: {
        chat: {
          completions: {
            create: (request: CapturedRequestBody) => AsyncIterable<{
              choices: Array<{ delta?: { content?: string }; finish_reason?: string }>
            }>
          }
        }
      }
    }
  ).client.chat.completions.create = (
    request,
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
  for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], [])) void _
  return captured.request ?? {}
}

describe('createProvider prompt cache key', () => {
  it('threads promptCacheKey into the OpenAI request body', async () => {
    const provider = createProvider(
      'gpt-4o',
      { openAiApiKey: 'test-openai' },
      'thread-xyz',
    ) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, 'thread-xyz')
  })

  it('threads promptCacheKey into the OpenRouter request body', async () => {
    const provider = createOpenRouterProvider(
      'openai/gpt-4o',
      'sk-or-test',
      'thread-xyz',
    ) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, 'thread-xyz')
  })

  it('omits prompt_cache_key when no key is supplied', async () => {
    const provider = createProvider('gpt-4o', { openAiApiKey: 'test-openai' }) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.equal(request.prompt_cache_key, undefined)
  })
})

describe('provider data-retention request defaults', () => {
  it('sends store:false to direct OpenAI so responses are not retained as app state', async () => {
    const provider = createProvider('gpt-4o', { openAiApiKey: 'test-openai' }) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.equal(request.store, false)
  })

  it('does not send store to OpenAI-compatible local servers', async () => {
    const provider = createLocalOpenAIProvider(
      'http://localhost:1234/v1',
      'qwen-local',
    ) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.equal(request.store, undefined)
  })

  it('requests ZDR-only, non-training OpenRouter routing by default', async () => {
    const provider = createOpenRouterProvider('openai/gpt-4o', 'sk-or-test') as OpenAIProvider
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, {
      require_parameters: true,
      zdr: true,
      data_collection: 'deny',
    })
  })

  it('keeps the training exclusion when only zdrOnly is turned off', async () => {
    const provider = createOpenRouterProvider('openai/gpt-4o', 'sk-or-test', undefined, {
      zdrOnly: false,
    }) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, { require_parameters: true, data_collection: 'deny' })
  })

  it('drops data_collection only with the explicit allowTraining opt-in', async () => {
    const provider = createOpenRouterProvider('openai/gpt-4o', 'sk-or-test', undefined, {
      zdrOnly: false,
      allowTraining: true,
    }) as OpenAIProvider
    const request = await captureRequest(provider)
    assert.deepEqual(request.provider, { require_parameters: true })
  })
})

describe('createLocalOpenAIProvider', () => {
  it('requests streamed usage so local models populate the usage ledger', async () => {
    const provider = createLocalOpenAIProvider(
      'http://localhost:1234/v1',
      'qwen/qwen3.6-35b-a3b',
    ) as OpenAIProvider
    type Captured = { request?: { stream_options?: { include_usage?: boolean } } | undefined }
    const captured: Captured = {}
    ;(
      provider as unknown as {
        client: {
          chat: {
            completions: {
              create: (request: NonNullable<Captured['request']>) => AsyncIterable<{
                choices: Array<{ delta?: { content?: string }; finish_reason?: string }>
              }>
            }
          }
        }
      }
    ).client.chat.completions.create = (
      request,
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

    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [])) {
      chunks.push(chunk)
    }

    assert.equal(captured.request?.stream_options?.include_usage, true)
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

describe('createExtraCloudProvider Responses transport', () => {
  it('uses the Responses transport for the Perplexity Agent API preset', () => {
    const perplexity = BUILTIN_EXTRA_PROVIDERS.find((provider) => provider.id === 'perplexity')
    assert.ok(perplexity)

    const provider = createExtraCloudProvider(perplexity, 'openai/gpt-5.6-sol', 'pplx-test')

    assert.ok(provider instanceof ResponsesProvider)
  })
})
