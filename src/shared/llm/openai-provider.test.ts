import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIProvider } from './openai-provider.ts'
import type { StreamChunk } from '@shared/types'

/**
 * Inject a fake OpenAI SDK stream into the provider's private client so we can
 * exercise the chat-completions delta parsing (text, tool-call assembly, usage)
 * without hitting the network. The provider only touches
 * `client.chat.completions.create(...)`, which returns an async-iterable of
 * streamed events.
 */
function withFakeStream(provider: OpenAIProvider, events: unknown[]): void {
  const fakeClient = {
    chat: {
      completions: {
        create() {
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e
            },
          }
        },
      },
    },
  }
  ;(provider as unknown as { client: unknown }).client = fakeClient
}

async function collect(provider: OpenAIProvider): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [])) {
    out.push(chunk)
  }
  return out
}

describe('OpenAIProvider stream parsing', () => {
  it('emits text deltas, a usage chunk, and a done chunk with the finish reason', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
      // Usage arrives on a trailing event with an empty choices array.
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ])

    const chunks = await collect(provider)

    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'Hello world')

    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.inputTokens, 12)
    assert.equal(usage.outputTokens, 3)
    assert.deepEqual(provider.lastUsage, { inputTokens: 12, outputTokens: 3 })

    const done = chunks.at(-1)
    assert.ok(done && done.type === 'done')
    assert.equal(done.stopReason, 'stop')
  })

  it('assembles tool-call argument fragments into a single tool_call chunk', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const chunks = await collect(provider)
    const toolCalls = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]!.toolCall.id, 'call_1')
    assert.equal(toolCalls[0]!.toolCall.name, 'read_file')
    assert.deepEqual(toolCalls[0]!.toolCall.args, { path: 'a.ts' })
    assert.equal(toolCalls[0]!.toolCall.argsError, undefined)

    const done = chunks.at(-1)
    assert.ok(done && done.type === 'done')
    assert.equal(done.stopReason, 'tool_calls')
  })

  it('surfaces a parse error when tool-call arguments are malformed JSON', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{not json' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const chunks = await collect(provider)
    const toolCall = chunks.find(
      (c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.ok(toolCall)
    assert.ok(toolCall.toolCall.argsError)
    assert.match(toolCall.toolCall.argsError!, /Could not parse tool arguments/)
  })

  it('does not emit a usage chunk when the stream reports no usage', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }])

    const chunks = await collect(provider)
    assert.equal(
      chunks.some((c) => c.type === 'usage'),
      false,
    )
    assert.equal(provider.lastUsage, null)
  })
})
