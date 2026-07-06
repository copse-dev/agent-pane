import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { anthropicMaxOutputTokens, getModelInfo } from './model-catalog.ts'
import { isRetryableStreamError, streamRetryDelayMs } from './stream-retry.ts'
import type { ProviderStreamChunk } from './wire-types.ts'
import { createLocalOpenAIProvider, createProvider } from './create-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'

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
