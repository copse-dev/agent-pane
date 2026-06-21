import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { anthropicMaxOutputTokens, getModelInfo } from './model-catalog.ts'
import { isRetryableStreamError, streamRetryDelayMs } from './stream-retry.ts'
import { createProvider } from './create-provider.ts'

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
    const prevMock = process.env.COPSE_PANEL_MOCK_LLM
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    const prevOpenai = process.env.OPENAI_API_KEY
    delete process.env.COPSE_PANEL_MOCK_LLM
    process.env.ANTHROPIC_API_KEY = 'test-anthropic'
    delete process.env.OPENAI_API_KEY
    try {
      assert.throws(
        () => createProvider('gpt-4o', { anthropicApiKey: 'test-anthropic', openAiApiKey: null }),
        /OpenAI is not configured/,
      )
    } finally {
      if (prevMock === undefined) delete process.env.COPSE_PANEL_MOCK_LLM
      else process.env.COPSE_PANEL_MOCK_LLM = prevMock
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevAnthropic
      if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevOpenai
    }
  })
})
