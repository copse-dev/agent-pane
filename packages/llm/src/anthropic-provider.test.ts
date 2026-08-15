import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider, markTrailingCacheBreakpoint } from './anthropic-provider.ts'
import type { LLMMessage, ProviderStreamChunk } from './wire-types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordAt(value: unknown, index: number): Record<string, unknown> {
  assert.ok(Array.isArray(value))
  const entry: unknown = value[index]
  assert.ok(isRecord(entry))
  return entry
}

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
  Object.defineProperty(provider, 'client', { value: fakeClient, configurable: true })
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
    const sentTools = capture.params['tools']
    assert.equal(recordAt(sentTools, 0)['cache_control'], undefined)
    assert.deepEqual(recordAt(sentTools, 1)['cache_control'], { type: 'ephemeral' })
    const sentMessages = capture.params['messages']
    // Earlier messages keep their plain string content …
    assert.equal(recordAt(sentMessages, 0)['content'], 'question')
    // … while the final message's final block carries the breakpoint.
    assert.ok(Array.isArray(sentMessages))
    const lastMessage: unknown = sentMessages.at(-1)
    assert.ok(isRecord(lastMessage))
    const lastContent = lastMessage['content']
    assert.ok(Array.isArray(lastContent))
    assert.deepEqual(lastContent.at(-1), {
      type: 'text',
      text: 'answer',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('keeps the breakpoint on the last body message, not on trailing steering', async () => {
    // The operator instruction is regenerated per turn and never persisted, so
    // the entry this request writes must stop before it — otherwise the next
    // turn's prefix (which lacks the instruction) cannot match it (#1286).
    const provider = new AnthropicProvider('claude-opus-4-8', { apiKey: 'test' })
    const capture = withFakeStream(provider, doneEvents)
    for await (const _ of provider.stream(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'question' },
        { role: 'system', content: 'steer me' },
      ],
      [],
    )) {
      void _
    }

    assert.ok(capture.params)
    assert.deepEqual(capture.params['messages'], [
      // The breakpoint marks the user turn — the last message the next turn
      // will resend verbatim …
      {
        role: 'user',
        content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }],
      },
      // … and the steering trails it, uncached.
      { role: 'system', content: 'steer me' },
    ])
  })

  it('markTrailingCacheBreakpoint handles block-array and empty inputs', () => {
    const toolResult = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'ok' }],
      },
    ]
    markTrailingCacheBreakpoint(toolResult)
    const content: unknown = toolResult[0]?.content[0]
    assert.ok(isRecord(content))
    assert.deepEqual(content['cache_control'], { type: 'ephemeral' })

    // Empty conversation and empty-string content are left untouched.
    markTrailingCacheBreakpoint([])
    const empty = [{ role: 'user' as const, content: '' }]
    markTrailingCacheBreakpoint(empty)
    assert.equal(empty[0]?.content, '')
  })
})

describe('AnthropicProvider mid-conversation system messages (#1286)', () => {
  const doneEvents = [
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]

  /** Run one turn against the fake stream and return the request body sent. */
  async function requestFor(
    model: string,
    messages: LLMMessage[],
  ): Promise<Record<string, unknown>> {
    const provider = new AnthropicProvider(model, { apiKey: 'test' })
    const capture = withFakeStream(provider, doneEvents)
    for await (const _ of provider.stream(messages, [])) void _
    assert.ok(capture.params)
    return capture.params
  }

  const cachedQuestion = {
    role: 'user',
    content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }],
  }

  it('sends a real system turn on a model that supports it', async () => {
    const params = await requestFor('claude-opus-4-8', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
      { role: 'system', content: 'terse mode' },
    ])

    // The leading system message is still the top-level prompt, not a turn.
    assert.deepEqual(params['system'], [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ])
    assert.deepEqual(params['messages'], [
      cachedQuestion,
      { role: 'system', content: 'terse mode' },
    ])
  })

  it('does not invent a system-reminder pseudo-role for explicit system input', async () => {
    // Capability-aware turn assembly keeps this shape away from unsupported
    // models. The provider mapping itself stays literal rather than silently
    // weakening an operator instruction into user content.
    const params = await requestFor('claude-sonnet-4-6', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
      { role: 'system', content: 'terse mode' },
    ])

    assert.deepEqual(params['messages'], [
      cachedQuestion,
      { role: 'system', content: 'terse mode' },
    ])
  })

  it('drops an empty operator instruction rather than sending an empty block', async () => {
    const params = await requestFor('claude-opus-4-8', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
      { role: 'system', content: '' },
    ])

    assert.deepEqual(params['messages'], [cachedQuestion])
  })

  it('still sends the system parameter when the only system message is empty', async () => {
    // Pre-existing behaviour: a leading system message produces the parameter
    // even when its text is empty. Splitting it out must not change that.
    const params = await requestFor('claude-test', [
      { role: 'system', content: '' },
      { role: 'user', content: 'question' },
    ])

    assert.deepEqual(params['system'], [
      { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('AnthropicProvider tuned parameters', () => {
  it('pairs a chosen effort with adaptive thinking', async () => {
    const provider = new AnthropicProvider('claude-opus-5', {
      apiKey: 'test',
      params: { reasoning: 'xhigh' },
    })
    const capture = withFakeStream(provider, [])
    await collect(provider)
    assert.ok(capture.params)
    assert.deepEqual(capture.params['thinking'], { type: 'adaptive' })
    assert.deepEqual(capture.params['output_config'], { effort: 'xhigh' })
  })

  it('disables thinking rather than naming an effort for "off"', async () => {
    const provider = new AnthropicProvider('claude-opus-5', {
      apiKey: 'test',
      params: { reasoning: 'off' },
    })
    const capture = withFakeStream(provider, [])
    await collect(provider)
    assert.ok(capture.params)
    assert.deepEqual(capture.params['thinking'], { type: 'disabled' })
    assert.equal(capture.params['output_config'], undefined)
  })

  it('sends sampling for a model that still accepts it', async () => {
    const provider = new AnthropicProvider('claude-sonnet-4-6', {
      apiKey: 'test',
      params: { temperature: 0.2, topP: 0.9 },
    })
    const capture = withFakeStream(provider, [])
    await collect(provider)
    assert.ok(capture.params)
    assert.equal(capture.params['temperature'], 0.2)
    assert.equal(capture.params['top_p'], 0.9)
  })

  it('leaves an untuned request body free of parameter fields', async () => {
    const provider = new AnthropicProvider('claude-opus-5', { apiKey: 'test' })
    const capture = withFakeStream(provider, [])
    await collect(provider)
    assert.ok(capture.params)
    assert.equal(capture.params['thinking'], undefined)
    assert.equal(capture.params['output_config'], undefined)
    assert.equal(capture.params['temperature'], undefined)
    assert.equal(capture.params['top_p'], undefined)
  })
})
