import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider, markTrailingCacheBreakpoint } from './anthropic-provider.ts'
import type { ProviderStreamChunk } from './wire-types.ts'

/**
 * Build a fake SDK stream event sequence and inject it into the provider's
 * private client so we can exercise the message_start / message_delta usage
 * accounting (#111) without hitting the network. Returns a capture object
 * whose `params` records the request body passed to the SDK.
 */
function withFakeStream(
  provider: AnthropicProvider,
  events: unknown[],
): { params: Record<string, unknown> | null } {
  const capture: { params: Record<string, unknown> | null } = { params: null }
  const fakeClient = {
    messages: {
      stream(params: Record<string, unknown>): AsyncIterable<unknown> {
        capture.params = params
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator {
            for (const e of events) yield e
          },
        }
      },
    },
  }
  ;(provider as unknown as { client: unknown }).client = fakeClient
  return capture
}

async function collect(provider: AnthropicProvider): Promise<ProviderStreamChunk[]> {
  const out: ProviderStreamChunk[] = []
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
    assert.ok(usage)
    // input = fresh + cache_creation + cache_read = 1200 + 300 + 500
    assert.equal(usage.inputTokens, 2000)
    // output comes from the final message_delta
    assert.equal(usage.outputTokens, 42)
    assert.deepEqual(provider.lastUsage, { inputTokens: 2000, outputTokens: 42 })
  })

  it('emits thinking_delta as reasoning chunks, separate from answer text', async () => {
    const provider = new AnthropicProvider('claude-test', { apiKey: 'test' })
    withFakeStream(provider, [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'check.' } },
      // signature_delta is verification metadata and must not surface as text.
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ])

    const chunks = await collect(provider)
    const reasoning = chunks
      .filter(
        (c): c is Extract<ProviderStreamChunk, { type: 'reasoning' }> => c.type === 'reasoning',
      )
      .map((c) => c.text)
      .join('')
    assert.equal(reasoning, 'Let me check.')
    const text = chunks
      .filter((c): c is Extract<ProviderStreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'Hello')
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
    assert.ok(usage)
    assert.equal(usage.inputTokens, 800)
    assert.equal(usage.outputTokens, 9)
  })
})

describe('AnthropicProvider prompt caching (#582)', () => {
  const doneEvents = [
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]

  it('marks the last tool and the last message block with cache_control', async () => {
    const provider = new AnthropicProvider('claude-test', { apiKey: 'test' })
    const capture = withFakeStream(provider, doneEvents)
    const tools = [
      { name: 'a', description: 'first', parameters: {} },
      { name: 'b', description: 'second', parameters: {} },
    ]
    for await (const _ of provider.stream(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
      tools,
    )) {
      void _
    }

    assert.ok(capture.params)
    const sentTools = capture.params['tools'] as Array<Record<string, unknown>>
    assert.equal(sentTools[0]?.['cache_control'], undefined)
    assert.deepEqual(sentTools[1]?.['cache_control'], { type: 'ephemeral' })
    const sentMessages = capture.params['messages'] as Array<{
      content: string | Array<Record<string, unknown>>
    }>
    // Earlier messages keep their plain string content …
    assert.equal(sentMessages[0]?.content, 'question')
    // … while the final message's final block carries the breakpoint.
    const lastContent = sentMessages.at(-1)?.content
    assert.ok(Array.isArray(lastContent))
    assert.deepEqual(lastContent.at(-1), {
      type: 'text',
      text: 'answer',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('markTrailingCacheBreakpoint handles block-array and empty inputs', () => {
    const toolResult = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'ok' }],
      },
    ]
    markTrailingCacheBreakpoint(toolResult)
    assert.deepEqual(
      (toolResult[0]?.content[0] as unknown as Record<string, unknown>)['cache_control'],
      { type: 'ephemeral' },
    )

    // Empty conversation and empty-string content are left untouched.
    markTrailingCacheBreakpoint([])
    const empty = [{ role: 'user' as const, content: '' }]
    markTrailingCacheBreakpoint(empty)
    assert.equal(empty[0]?.content, '')
  })
})
