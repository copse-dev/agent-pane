import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from './internal-utils.ts'
import type { ImageDetail, LLMTool, ProviderStreamChunk } from './wire-types.ts'
import { OpenAIProvider } from './openai-provider.ts'

interface CapturedChatCompletionRequest {
  model: string
  messages?: unknown
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  provider?: { require_parameters?: boolean }
  prompt_cache_key?: string
  max_tokens?: number
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
}

interface ChatCompletionChunk {
  choices: Array<{
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
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
  Object.defineProperty(provider, 'client', {
    value: { chat: { completions: { create } } },
    configurable: true,
  })
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

async function collect(
  provider: OpenAIProvider,
  tools: LLMTool[] = [],
): Promise<ProviderStreamChunk[]> {
  const out: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], tools)) {
    out.push(chunk)
  }
  return out
}

/**
 * Every `image_url` object anywhere in a chat-completions request, in document
 * order. Walks structurally so the test needs no assertions about the SDK's
 * deeply-nested message-part unions.
 */
function collectImageUrls(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) collectImageUrls(child, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = { ...value }
    const imageUrl = record['image_url']
    if (record['type'] === 'image_url' && imageUrl !== null && typeof imageUrl === 'object') {
      found.push({ ...imageUrl })
    }
    for (const child of Object.values(record)) collectImageUrls(child, found)
  }
  return found
}

describe('OpenAIProvider image detail', () => {
  async function capturedImageUrls(
    ...details: (ImageDetail | undefined)[]
  ): Promise<Record<string, unknown>[]> {
    const provider = new OpenAIProvider('gpt-test', { apiKey: 'test-openai-key' })
    const captured: { request?: { messages?: unknown } } = {}
    Object.defineProperty(provider, 'client', {
      value: {
        chat: {
          completions: {
            create: (request: { messages?: unknown }) => {
              captured.request = request
              return streamEvents([
                { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
              ])
            },
          },
        },
      },
      configurable: true,
    })
    for await (const _ of provider.stream(
      [
        {
          role: 'user',
          content: details.map((detail, i) => ({
            type: 'image' as const,
            dataUrl: `data:image/png;base64,img${String(i)}`,
            ...(detail ? { detail } : {}),
          })),
        },
      ],
      [],
    )) {
      // drain
    }
    const found = collectImageUrls(captured.request?.messages)
    assert.equal(found.length, details.length, 'expected one image part per requested detail')
    return found
  }

  it('omits detail entirely by default, so the request is byte-identical to before', async () => {
    // Explicitly sending detail:'auto' would be a no-op for OpenAI but a new
    // unknown field for the OpenAI-compatible servers this adapter also drives.
    assert.deepEqual(await capturedImageUrls(undefined), [{ url: 'data:image/png;base64,img0' }])
  })

  it('omits detail when auto is set explicitly on the part', async () => {
    assert.deepEqual(await capturedImageUrls('auto'), [{ url: 'data:image/png;base64,img0' }])
  })

  it('sends a non-auto fidelity through on the part that carries it', async () => {
    assert.deepEqual(await capturedImageUrls('low'), [
      { url: 'data:image/png;base64,img0', detail: 'low' },
    ])
    assert.deepEqual(await capturedImageUrls('high'), [
      { url: 'data:image/png;base64,img0', detail: 'high' },
    ])
  })

  it('keeps each image on its own detail within one message', async () => {
    // The whole point of moving this off the provider: one request can carry a
    // screenshot that must stay legible and a frame that need not.
    assert.deepEqual(await capturedImageUrls('high', 'low', undefined), [
      { url: 'data:image/png;base64,img0', detail: 'high' },
      { url: 'data:image/png;base64,img1', detail: 'low' },
      { url: 'data:image/png;base64,img2' },
    ])
  })
})

describe('OpenAIProvider request options', () => {
  it('maps developer messages onto the chat-completions developer role', async () => {
    const provider = new OpenAIProvider('gpt-5', { apiKey: 'test-openai-key' })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    for await (const _ of provider.stream(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'question' },
        { role: 'developer', content: 'steer' },
      ],
      [],
    )) {
      void _
    }

    assert.deepEqual(captured.request?.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'question' },
      { role: 'developer', content: 'steer' },
    ])
  })

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

  it('sends the output ceiling it was built with', async () => {
    const provider = new OpenAIProvider('deepseek-v4-flash-0731', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
      maxOutputTokens: 384_000,
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.equal(captured.request?.max_tokens, 384_000)
  })

  it('drops an output ceiling the server rejects and retries without it', async () => {
    // The card's number is written against the vendor's own API; an aggregator
    // or a self-hosted server may serve the same weights with a lower cap.
    const provider = new OpenAIProvider('deepseek-v4-flash-0731', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
      maxOutputTokens: 384_000,
    })
    const seen: Array<number | undefined> = []
    withFakeCreate(provider, (request) => {
      seen.push(request.max_tokens)
      if (seen.length === 1) {
        throw Object.assign(new Error('max_tokens is too large: 384000'), { status: 400 })
      }
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    const chunks = await collect(provider)

    assert.deepEqual(seen, [384_000, undefined])
    assert.equal(
      chunks
        .filter((c): c is Extract<ProviderStreamChunk, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join(''),
      'ok',
    )
  })

  it('surfaces a rejection that is not about the ceiling', async () => {
    const provider = new OpenAIProvider('deepseek-v4-flash-0731', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
      maxOutputTokens: 384_000,
    })
    let calls = 0
    withFakeCreate(provider, () => {
      calls += 1
      throw Object.assign(new Error('context length exceeded'), { status: 400 })
    })

    await assert.rejects(collect(provider), /context length exceeded/)
    assert.equal(calls, 1)
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

  it('sends prompt_cache_key when a promptCacheKey is configured', async () => {
    const provider = new OpenAIProvider('gpt-test', {
      apiKey: 'test-openai-key',
      promptCacheKey: 'thread-abc',
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.equal(captured.request?.prompt_cache_key, 'thread-abc')
  })

  it('omits prompt_cache_key when no promptCacheKey is configured', async () => {
    const provider = new OpenAIProvider('gpt-test', { apiKey: 'test-openai-key' })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })

    await collect(provider)

    assert.equal(captured.request?.prompt_cache_key, undefined)
  })

  it('normalizes legacy boolean exclusive bounds for OpenAI-compatible servers', async () => {
    const provider = new OpenAIProvider('poolside-model', {
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
    })
    const captured: { request?: CapturedChatCompletionRequest } = {}
    withFakeCreate(provider, (request) => {
      captured.request = request
      return streamEvents([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })
    const parameters = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 0, exclusiveMinimum: true },
        ratio: { type: 'number', maximum: 1, exclusiveMaximum: false },
        nested: {
          type: 'array',
          items: { type: 'number', minimum: -1, exclusiveMinimum: true },
        },
      },
    }
    const tools: LLMTool[] = [{ name: 'calculate', description: 'Calculate', parameters }]

    await collect(provider, tools)

    assert.deepEqual(captured.request?.tools?.[0]?.function.parameters, {
      type: 'object',
      properties: {
        count: { type: 'integer', exclusiveMinimum: 0 },
        ratio: { type: 'number', maximum: 1 },
        nested: {
          type: 'array',
          items: { type: 'number', exclusiveMinimum: -1 },
        },
      },
    })
    assert.deepEqual(parameters.properties.count, {
      type: 'integer',
      minimum: 0,
      exclusiveMinimum: true,
    })
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
      .filter((c): c is Extract<ProviderStreamChunk, { type: 'text' }> => c.type === 'text')
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
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
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

  it('synthesizes distinct ids for parallel tool calls a server left unidentified', async () => {
    // LM Studio / llama.cpp / vLLM can stream tool calls with no `id`. Both used
    // to arrive as '', collide on the result-correlation key, and lose a result.
    const provider = new OpenAIProvider('local-model', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
    })
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
                { index: 1, function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const toolCalls = (await collect(provider)).filter(
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 2)
    const ids = toolCalls.map((c) => c.toolCall.id)
    for (const id of ids) assert.match(id, /^tc_/)
    assert.equal(new Set(ids).size, 2, 'each unidentified tool call needs its own id')
    // The synthesized id must not disturb the rest of the call.
    assert.deepEqual(at(toolCalls, 0).toolCall.args, { path: 'a.ts' })
    assert.deepEqual(at(toolCalls, 1).toolCall.args, { path: 'b.ts' })
  })

  it('keeps a provider-supplied tool-call id instead of synthesizing one', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_real', function: { name: 'list_dir', arguments: '{}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const toolCalls = (await collect(provider)).filter(
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).toolCall.id, 'call_real')
  })

  it('synthesizes an id when the id arrives blank across the call deltas', async () => {
    const provider = new OpenAIProvider('gpt-test')
    withFakeStream(provider, [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: '  ', function: { name: 'list_dir' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const toolCalls = (await collect(provider)).filter(
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 1)
    assert.match(at(toolCalls, 0).toolCall.id, /^tc_/)
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
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
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
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.ok(toolCall)
    assert.ok(toolCall.toolCall.argsError)
    assert.match(toolCall.toolCall.argsError, /Could not parse tool arguments/)
  })

  it('emits reasoning chunks from reasoning_content and reasoning deltas', async () => {
    const provider = new OpenAIProvider('local-model', {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'local-key',
    })
    withFakeStream(provider, [
      // DeepSeek/LM Studio style.
      { choices: [{ delta: { reasoning_content: 'Think ' }, finish_reason: null }] },
      // OpenRouter style.
      { choices: [{ delta: { reasoning: 'harder.' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] },
    ])

    const chunks = await collect(provider)
    const reasoning = chunks
      .filter(
        (c): c is Extract<ProviderStreamChunk, { type: 'reasoning' }> => c.type === 'reasoning',
      )
      .map((c) => c.text)
      .join('')
    assert.equal(reasoning, 'Think harder.')
    const text = chunks
      .filter((c): c is Extract<ProviderStreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'Answer')
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
