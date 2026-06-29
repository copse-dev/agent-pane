import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider } from './anthropic-provider.ts'
import type { StreamChunk } from '@shared/types'

/**
 * Build a fake SDK stream event sequence and inject it into the provider's
 * private client so we can exercise the message_start / message_delta usage
 * accounting (#111) without hitting the network.
 */
function withFakeStream(provider: AnthropicProvider, events: unknown[]): void {
  const fakeClient = {
    messages: {
      stream(): AsyncIterable<unknown> {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
            for (const e of events) yield e
          },
        }
      },
    },
  }
  ;(provider as unknown as { client: unknown }).client = fakeClient
}

async function collect(provider: AnthropicProvider): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [])) {
    out.push(chunk)
  }
  return out
}

describe('AnthropicProvider usage accounting (#111)', () => {
  it('reads authoritative input tokens from message_start, output from message_delta', async () => {
    const provider = new AnthropicProvider('claude-test', { apiKey: 'test' })
    withFakeStream(provider, [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1200,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 500,
            output_tokens: 1,
          },
        },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ])

    const chunks = await collect(provider)
    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    // input = fresh + cache_creation + cache_read = 1200 + 300 + 500
    assert.equal(usage.inputTokens, 2000)
    // output comes from the final message_delta
    assert.equal(usage.outputTokens, 42)
    assert.deepEqual(provider.lastUsage, { inputTokens: 2000, outputTokens: 42 })
  })

  it('does not zero out input when message_delta reports null input_tokens', async () => {
    const provider = new AnthropicProvider('claude-test', { apiKey: 'test' })
    withFakeStream(provider, [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 800,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            output_tokens: 1,
          },
        },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    ])

    const chunks = await collect(provider)
    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.inputTokens, 800)
    assert.equal(usage.outputTokens, 9)
  })
})
