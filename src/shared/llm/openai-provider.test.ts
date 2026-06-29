import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import type { StreamChunk } from '@shared/types'
import { OpenAIProvider } from './openai-provider.ts'

interface CapturedChatCompletionRequest {
  model: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  provider?: { require_parameters?: boolean }
}

interface ChatCompletionChunk {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

interface OpenAIProviderForTest {
  client: {
    chat: {
      completions: {
        create: (
          request: CapturedChatCompletionRequest,
          opts?: unknown,
        ) => AsyncIterable<ChatCompletionChunk>
      }
    }
  }
}

async function* streamEvents(events: ChatCompletionChunk[]): AsyncIterable<ChatCompletionChunk> {
  for (const event of events) yield event
}

function withFakeCreate(
  provider: OpenAIProvider,
  create: OpenAIProviderForTest['client']['chat']['completions']['create'],
): void {
  ;(provider as unknown as OpenAIProviderForTest).client.chat.completions.create = create
}

/**
 * Inject a fake OpenAI SDK stream into the provider's private client so we can
 * exercise the chat-completions delta parsing (text, tool-call assembly, usage)
 * without hitting the network. The provider only touches
 * `client.chat.completions.create(...)`, which returns an async-iterable of
 * streamed events.
 */
function withFakeStream(provider: OpenAIProvider, events: ChatCompletionChunk[]): void {
  withFakeCreate(provider, () => streamEvents(events))
}

async function collect(provider: OpenAIProvider): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [])) {
    out.push(chunk)
  }
  return out
}

describe('OpenAIProvider request options', () => {
  it('asks OpenAI cloud streams to include usage', async () => {
    const provider = new OpenAIProvider('gpt-test', { apiKey: 'test-openai-key' })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.equal(captured.request?.stream_options?.include_usage, true)
  })

  it('omits stream_options for custom base URLs by default', async () => {
    const provider = new OpenAIProvider('local-model', {
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'local-key',
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.equal(captured.request?.stream_options, undefined)
  })

  it('requests usage for local servers when includeUsage is enabled', async () => {
    const provider = new OpenAIProvider('qwen/qwen3.6-35b-a3b', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
      includeUsage: true,
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 400, completion_tokens: 50 } },
      ])
    })

    await collect(provider)

    assert.equal(captured.request?.stream_options?.include_usage, true)
  })

  it('merges extraBody (e.g. OpenRouter require_parameters) into the request', async () => {
    const provider = new OpenAIProvider('deepseek/deepseek-chat', {
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      includeUsage: true,
      extraBody: { provider: { require_parameters: true } },
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.deepEqual(captured.request?.provider, { require_parameters: true })
    assert.equal(captured.request.stream_options?.include_usage, true)
  })
})

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
    assert.ok(usage)
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
    assert.equal(at(toolCalls, 0).toolCall.id, 'call_1')
    assert.equal(at(toolCalls, 0).toolCall.name, 'read_file')
    assert.deepEqual(at(toolCalls, 0).toolCall.args, { path: 'a.ts' })
    assert.equal(at(toolCalls, 0).toolCall.argsError, undefined)

    const done = chunks.at(-1)
    assert.ok(done && done.type === 'done')
    assert.equal(done.stopReason, 'tool_calls')
  })

  it('flushes tool calls when the stream ends with finish_reason stop', async () => {
    const provider = new OpenAIProvider('local-model', {
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'local-key',
    })
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '{"path":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] },
            finish_reason: 'stop',
          },
        ],
      },
    ])

    const chunks = await collect(provider)
    const toolCalls = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).toolCall.name, 'list_dir')
    assert.deepEqual(at(toolCalls, 0).toolCall.args, { path: '.' })
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
    assert.match(toolCall.toolCall.argsError, /Could not parse tool arguments/)
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
