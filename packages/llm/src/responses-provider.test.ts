import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@copse/std/array-utils.ts'
import { ResponsesProvider, toResponsesInput } from './responses-provider.ts'
import { createProvider } from './create-provider.ts'
import type { LLMMessage, LLMTool, ProviderStreamChunk } from './wire-types.ts'

interface CapturedRequest {
  model: string
  input: unknown
  stream: boolean
  tools: Array<Record<string, unknown>>
  max_output_tokens?: number
  reasoning?: { summary?: string; effort?: string }
  text?: { verbosity?: string }
  parallel_tool_calls?: boolean
  include?: readonly string[]
  prompt_cache_key?: string
  store?: boolean
  temperature?: number
  metadata?: unknown
}

type TestEvent =
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'error'; message: string; param: string | null; code: string | null }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | { type: 'response.reasoning_text.delta'; delta: string }
  | {
      type: 'response.output_item.done'
      // `call_id` is optional here so a test can model a third-party Responses
      // endpoint that omits it; OpenAI itself always sends one.
      item: { type: 'function_call'; call_id?: string; name: string; arguments: string }
    }
  | {
      type: 'response.output_item.done'
      item: { type: 'reasoning'; id: string; encrypted_content?: string }
    }
  | {
      type: 'response.completed'
      response: {
        service_tier?: string
        output: Array<{ type: string }>
        usage: {
          input_tokens: number
          output_tokens: number
          input_tokens_details: { cached_tokens: number }
        }
      }
    }

interface ResponsesProviderForTest {
  client: {
    responses: {
      create: (
        request: CapturedRequest,
        options?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<TestEvent>>
    }
  }
}

async function* streamEvents(events: readonly TestEvent[]): AsyncIterable<TestEvent> {
  for (const event of events) yield event
}

function withFakeStream(
  provider: ResponsesProvider,
  capture: (request: CapturedRequest, options?: { signal?: AbortSignal }) => void,
  events: readonly TestEvent[],
): void {
  const create: ResponsesProviderForTest['client']['responses']['create'] = async (
    request,
    options,
  ): Promise<AsyncIterable<TestEvent>> => {
    capture(request, options)
    return streamEvents(events)
  }
  Object.defineProperty(provider, 'client', {
    value: { responses: { create } },
    configurable: true,
  })
}

async function collect(
  provider: ResponsesProvider,
  messages: LLMMessage[] = [{ role: 'user', content: 'hi' }],
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ])) {
    chunks.push(chunk)
  }
  return chunks
}

/**
 * Every `detail` on an `input_image` part anywhere in a Responses input, in
 * document order. Walks structurally rather than reaching through the SDK's
 * union types, which don't narrow usefully by `role`.
 */
function collectImageDetails(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) collectImageDetails(child, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = { ...value }
    if (record['type'] === 'input_image' && typeof record['detail'] === 'string') {
      found.push(record['detail'])
    }
    for (const child of Object.values(record)) collectImageDetails(child, found)
  }
  return found
}

describe('ChatGPT plan Responses contract', () => {
  it('namespaces local tools, maps system instructions, and omits unsupported overrides', async () => {
    const provider = new ResponsesProvider('gpt-6.1-sol', {
      apiKey: 'oauth-token',
      chatGptPlan: true,
      params: { temperature: 0.5, topP: 0.7, reasoning: 'high' },
      maxOutputTokens: 100,
      serverTools: [{ type: 'web_search' }],
      extraBody: { store: true, metadata: { leaked: true }, temperature: 1 },
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (body) => {
        request = body
      },
      [
        {
          type: 'response.completed',
          response: {
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ],
    )
    const chunks = await collect(provider, [{ role: 'system', content: 'Use Copse tools.' }])
    assert.ok(request)
    assert.equal(request.store, false)
    assert.equal(request.stream, true)
    assert.equal(request.temperature, undefined)
    assert.equal(request.metadata, undefined)
    assert.equal(request.max_output_tokens, undefined)
    assert.deepEqual(request.input, [{ role: 'developer', content: 'Use Copse tools.' }])
    assert.deepEqual(
      request.tools.map((tool) => [tool['type'], tool['name']]),
      [['namespace', 'copse']],
    )
    assert.equal(request.reasoning?.effort, 'high')
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('keeps plan tools non-strict while normalizing legacy bounds without mutating them', async () => {
    const provider = new ResponsesProvider('gpt-5.6-luna', {
      apiKey: 'oauth-token',
      chatGptPlan: true,
      strictTools: true,
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (body) => {
        request = body
      },
      [
        {
          type: 'response.completed',
          response: {
            output: [],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ],
    )
    const parameters = {
      type: 'object',
      properties: {
        runId: { type: 'integer', minimum: 0, exclusiveMinimum: true },
        limit: { type: 'integer', maximum: 100, exclusiveMaximum: false },
        nested: {
          anyOf: [{ type: 'number', maximum: 1, exclusiveMaximum: true }, { type: 'null' }],
        },
        modern: { type: 'number', exclusiveMinimum: 2 },
      },
    }
    const original = structuredClone(parameters)
    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'test' }],
      [
        {
          name: 'get_ci_failure_logs',
          description: 'Read CI failure logs',
          parameters,
        },
      ],
    )) {
      /* Drain the request. */
    }
    assert.ok(request)
    assert.deepEqual(request.tools, [
      {
        type: 'namespace',
        name: 'copse',
        description: 'Copse local tools',
        tools: [
          {
            type: 'function',
            name: 'get_ci_failure_logs',
            description: 'Read CI failure logs',
            strict: false,
            parameters: {
              type: 'object',
              properties: {
                runId: { type: 'integer', exclusiveMinimum: 0 },
                limit: { type: 'integer', maximum: 100 },
                nested: { anyOf: [{ type: 'number', exclusiveMaximum: 1 }, { type: 'null' }] },
                modern: { type: 'number', exclusiveMinimum: 2 },
              },
            },
          },
        ],
      },
    ])
    assert.deepEqual(parameters, original)
  })

  it('replays namespaced calls and tool outputs as full stateless input', () => {
    const input = toResponsesInput(
      [
        {
          role: 'assistant',
          content: [{ id: 'call-1', name: 'read_file', args: { path: 'index.ts' } }],
        },
        { role: 'tool', toolResults: [{ toolCallId: 'call-1', result: 'contents' }] },
      ],
      new Map(),
      true,
    )
    assert.deepEqual(input, [
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        namespace: 'copse',
        arguments: '{"path":"index.ts"}',
      },
      { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
    ])
  })

  it('fails on a truncated stream and never retries a partially delivered response', async () => {
    const provider = new ResponsesProvider('gpt-6.1-sol', {
      apiKey: 'oauth-token',
      chatGptPlan: true,
    })
    let calls = 0
    withFakeStream(provider, () => {
      calls++
    }, [{ type: 'response.output_text.delta', delta: 'partial' }])
    await assert.rejects(collect(provider), /before response.completed/)
    assert.equal(calls, 1)
    assert.throws(
      () =>
        new ResponsesProvider('model', {
          apiKey: 'oauth-token',
          chatGptPlan: true,
          baseURL: 'https://example.com/v1',
        }),
      /public OpenAI API/,
    )
  })
})

describe('ResponsesProvider input mapping', () => {
  it('maps messages, function calls, and function outputs to Responses items', () => {
    const input = toResponsesInput([
      { role: 'system', content: 'Use tools.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          { type: 'image', dataUrl: 'data:image/png;base64,abc' },
        ],
      },
      { role: 'developer', content: 'Be concise.' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        role: 'assistant',
        content: [{ id: 'call_1', name: 'read_file', args: { path: 'src/index.ts' } }],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'call_1', result: 'file contents' }] },
    ])

    assert.deepEqual(input, [
      { role: 'system', content: 'Use tools.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect this' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' },
        ],
      },
      { role: 'developer', content: 'Be concise.' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"src/index.ts"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ])
  })

  it('defaults image detail to auto, preserving the historical wire shape', () => {
    const input = toResponsesInput([
      { role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,abc' }] },
    ])
    assert.deepEqual(input, [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' }],
      },
    ])
  })

  it('carries a different detail per image within one message', () => {
    // The case a single provider-wide setting could never express: a screenshot
    // whose text has to stay legible sitting beside a frame worth downsampling.
    const input = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'image', dataUrl: 'data:image/png;base64,trace', detail: 'high' },
          { type: 'image', dataUrl: 'data:image/png;base64,frame', detail: 'low' },
          { type: 'text', text: 'what went wrong?' },
        ],
      },
    ])
    assert.deepEqual(collectImageDetails(input), ['high', 'low'])
  })

  it('leaves tool-result images at auto — nobody chose a detail for them', () => {
    const input = toResponsesInput([
      { role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,abc' }] },
      {
        role: 'tool',
        toolResults: [
          {
            toolCallId: 'call_1',
            result: 'captured',
            images: [{ dataUrl: 'data:image/png;base64,frame', name: 'frame-1.png' }],
          },
        ],
      },
    ])
    assert.deepEqual(collectImageDetails(input), ['auto', 'auto'])
  })
})

describe('ResponsesProvider streaming', () => {
  it('combines server and Copse tools, then maps streamed output and usage', async () => {
    const provider = new ResponsesProvider('openai/gpt-test', {
      baseURL: 'https://api.perplexity.ai/v1',
      apiKey: 'test-key',
      serverTools: [{ type: 'web_search' }],
      extraBody: { max_output_tokens: 8192 },
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [
        { type: 'response.reasoning_summary_text.delta', delta: 'Checking sources' },
        { type: 'response.output_text.delta', delta: 'Found it.' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_9',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        },
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'function_call' }],
            usage: {
              input_tokens: 120,
              output_tokens: 18,
              input_tokens_details: { cached_tokens: 40 },
            },
          },
        },
      ],
    )

    const chunks = await collect(provider)

    assert.ok(request)
    assert.equal(request.model, 'openai/gpt-test')
    assert.equal(request.stream, true)
    assert.equal(request.max_output_tokens, 8192)
    assert.deepEqual(request.tools, [
      { type: 'web_search' },
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        strict: false,
      },
    ])
    assert.deepEqual(chunks, [
      { type: 'reasoning', text: 'Checking sources' },
      { type: 'text', text: 'Found it.' },
      {
        type: 'tool_call',
        toolCall: { id: 'call_9', name: 'read_file', args: { path: 'README.md' } },
      },
      {
        type: 'usage',
        model: 'openai/gpt-test',
        inputTokens: 120,
        outputTokens: 18,
        cacheReadTokens: 40,
      },
      { type: 'done', stopReason: 'tool_calls' },
    ])
    assert.deepEqual(provider.lastUsage, { inputTokens: 120, outputTokens: 18 })
  })

  it('carries requested and actual service tiers with completed usage', async () => {
    const provider = new ResponsesProvider('gpt-test', {
      apiKey: 'test-key',
      serviceTier: 'flex',
    })
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.completed',
        response: {
          service_tier: 'priority',
          output: [],
          usage: {
            input_tokens: 120,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ])

    const chunks = await collect(provider)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.ok(usage)
    assert.equal(usage.requestedServiceTier, 'flex')
    assert.equal(usage.responseServiceTier, 'priority')
  })

  it('retries without an output ceiling that the endpoint rejects', async () => {
    const provider = new ResponsesProvider('gpt-5.6-sol', {
      apiKey: 'test-key',
      maxOutputTokens: 2_048,
    })
    const requests: CapturedRequest[] = []
    const create: ResponsesProviderForTest['client']['responses']['create'] = async (
      request,
    ): Promise<AsyncIterable<TestEvent>> => {
      requests.push(request)
      if (requests.length === 1) {
        throw Object.assign(new Error('max_output_tokens exceeds the limit for this model'), {
          status: 400,
        })
      }
      return streamEvents([{ type: 'response.output_text.delta', delta: 'ok' }])
    }
    Object.defineProperty(provider, 'client', {
      value: { responses: { create } },
      configurable: true,
    })

    const chunks = await collect(provider)

    assert.equal(at(requests, 0).max_output_tokens, 2_048)
    assert.equal(at(requests, 1).max_output_tokens, undefined)
    assert.deepEqual(chunks, [{ type: 'text', text: 'ok' }])
  })

  it('retries without an output ceiling the endpoint rejects inside the stream', async () => {
    async function run(firstStream: readonly TestEvent[]): Promise<{
      requests: CapturedRequest[]
      result: ProviderStreamChunk[] | Error
    }> {
      const provider = new ResponsesProvider('gpt-5.6-sol', {
        apiKey: 'test-key',
        maxOutputTokens: 2_048,
      })
      const requests: CapturedRequest[] = []
      const create: ResponsesProviderForTest['client']['responses']['create'] = async (
        request,
      ): Promise<AsyncIterable<TestEvent>> => {
        requests.push(request)
        return streamEvents(
          requests.length === 1
            ? firstStream
            : [{ type: 'response.output_text.delta', delta: 'ok' }],
        )
      }
      Object.defineProperty(provider, 'client', {
        value: { responses: { create } },
        configurable: true,
      })
      try {
        return { requests, result: await collect(provider) }
      } catch (err) {
        return { requests, result: err instanceof Error ? err : new Error(String(err)) }
      }
    }

    // Rejected before any output: retried once without the field.
    const rejected = await run([
      {
        type: 'error',
        message: "Unsupported parameter: 'max_output_tokens'",
        param: 'max_output_tokens',
        code: 'unsupported_parameter',
      },
    ])
    assert.equal(rejected.requests.length, 2)
    assert.equal(at(rejected.requests, 0).max_output_tokens, 2_048)
    assert.equal(at(rejected.requests, 1).max_output_tokens, undefined)
    assert.deepEqual(rejected.result, [{ type: 'text', text: 'ok' }])

    // An unrelated in-stream error still fails, with the ceiling kept.
    const unrelated = await run([
      { type: 'error', message: 'model overloaded', param: null, code: 'server_error' },
    ])
    assert.equal(unrelated.requests.length, 1)
    assert.ok(unrelated.result instanceof Error)

    // Once output reached the caller, a late rejection is not replayed.
    const late = await run([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'error', message: 'max_output_tokens exceeded', param: null, code: null },
    ])
    assert.equal(late.requests.length, 1)
    assert.ok(late.result instanceof Error)
  })

  it('synthesizes a tool-call id when a Responses endpoint omits call_id', async () => {
    const provider = new ResponsesProvider('openai/gpt-test', {
      baseURL: 'https://api.perplexity.ai/v1',
      apiKey: 'test-key',
    })
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ])

    const toolCalls = (await collect(provider)).filter(
      (c): c is Extract<ProviderStreamChunk, { type: 'tool_call' }> => c.type === 'tool_call',
    )
    assert.equal(toolCalls.length, 1)
    assert.match(at(toolCalls, 0).toolCall.id, /^tc_/)
  })
})

describe('ResponsesProvider reasoning', () => {
  function reasoningProvider(): ResponsesProvider {
    return new ResponsesProvider('gpt-5.6-sol', {
      apiKey: 'sk-test',
      reasoningSummaries: true,
      encryptedReasoning: true,
    })
  }

  it('asks for reasoning summaries and encrypted content when enabled', async () => {
    const provider = reasoningProvider()
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )

    await collect(provider)

    assert.ok(request)
    // Without summary:'auto' OpenAI streams no visible reasoning at all, which
    // is why GPT-5-class models showed no thinking on the Chat Completions path.
    assert.equal(request.reasoning?.summary, 'auto')
    // With store:false there is no server-side copy, so the encrypted blob has
    // to ride back on the response or it cannot be replayed.
    assert.deepEqual(request.include, ['reasoning.encrypted_content'])
  })

  it('sends both the summary request and the tuned effort', async () => {
    const provider = new ResponsesProvider('gpt-5.6-sol', {
      apiKey: 'sk-test',
      reasoningSummaries: true,
      params: { reasoning: 'high' },
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )

    await collect(provider)

    assert.ok(request)
    assert.deepEqual(request.reasoning, { summary: 'auto', effort: 'high' })
  })

  it('sends only the summary request when no level is tuned', async () => {
    const provider = reasoningProvider()
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )

    await collect(provider)

    assert.ok(request)
    assert.deepEqual(request.reasoning, { summary: 'auto' })
  })

  it('sends only the tuned effort when summaries are not requested', async () => {
    const provider = new ResponsesProvider('gpt-5.6-sol', {
      apiKey: 'sk-test',
      params: { reasoning: 'high' },
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )

    await collect(provider)

    assert.ok(request)
    assert.deepEqual(request.reasoning, { effort: 'high' })
  })

  it('omits both when the provider is not configured for reasoning', async () => {
    const provider = new ResponsesProvider('sonar', {
      baseURL: 'https://api.perplexity.ai/v1',
      apiKey: 'test-key',
    })
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )

    await collect(provider)

    assert.ok(request)
    assert.equal(request.reasoning, undefined)
    assert.equal(request.include, undefined)
  })

  it('replays the encrypted reasoning ahead of the tool calls it produced', async () => {
    const provider = reasoningProvider()
    // Turn 1: the model reasons, then calls a tool.
    withFakeStream(provider, () => undefined, [
      { type: 'response.reasoning_summary_text.delta', delta: 'Checking the file' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'BLOB1' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      },
    ])
    const chunks = await collect(provider)
    // The visible summary still reaches the transcript...
    assert.deepEqual(
      chunks.filter((c) => c.type === 'reasoning'),
      [{ type: 'reasoning', text: 'Checking the file' }],
    )
    // ...and the reasoning item itself is not mistaken for a tool call.
    assert.equal(chunks.filter((c) => c.type === 'tool_call').length, 1)

    // Turn 2: history now carries the assistant tool call and its result.
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'done' }],
    )
    await collect(provider, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ id: 'call_1', name: 'read_file', args: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'call_1', result: 'contents' }] },
    ])

    assert.ok(request)
    assert.deepEqual(request.input, [
      { role: 'user', content: 'hi' },
      // Reasoning goes back in its original position — before the calls it led to.
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB1' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
    ])
  })

  it('replays one reasoning block once for a parallel batch of tool calls', async () => {
    const provider = reasoningProvider()
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'BLOB1' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{}' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_b', name: 'read_file', arguments: '{}' },
      },
    ])
    await collect(provider)

    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'done' }],
    )
    await collect(provider, [
      {
        role: 'assistant',
        content: [
          { id: 'call_a', name: 'read_file', args: {} },
          { id: 'call_b', name: 'read_file', args: {} },
        ],
      },
    ])

    assert.ok(request)
    assert.deepEqual(request.input, [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB1' },
      { type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'call_b', name: 'read_file', arguments: '{}' },
    ])
  })

  it('keeps one ciphertext when the same reasoning id arrives twice', async () => {
    // OpenAI encrypts per event, so the same reasoning item can arrive under two
    // different ciphertexts. Replaying both would send the item twice — the bug
    // llm 0.32 fixed after its own rc2. The later payload wins.
    const provider = reasoningProvider()
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'EARLY' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'FINAL' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      },
    ])
    await collect(provider)

    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'done' }],
    )
    await collect(provider, [
      { role: 'assistant', content: [{ id: 'call_1', name: 'read_file', args: {} }] },
    ])

    assert.ok(request)
    assert.deepEqual(request.input, [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'FINAL' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    ])
  })

  it('ignores a reasoning item with no encrypted payload', async () => {
    // Nothing to replay, and sending an id alone with store:false is rejected.
    const provider = reasoningProvider()
    withFakeStream(provider, () => undefined, [
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      },
    ])
    await collect(provider)

    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'done' }],
    )
    await collect(provider, [
      { role: 'assistant', content: [{ id: 'call_1', name: 'read_file', args: {} }] },
    ])

    assert.ok(request)
    assert.deepEqual(request.input, [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    ])
  })

  it('does not retain reasoning when encryptedReasoning is off', async () => {
    // Perplexity and other Responses endpoints have no encrypted-reasoning
    // contract; replaying an OpenAI-shaped item at them would be a 400.
    const provider = new ResponsesProvider('sonar', {
      baseURL: 'https://api.perplexity.ai/v1',
      apiKey: 'test-key',
    })
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'BLOB1' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      },
    ])
    await collect(provider)

    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'done' }],
    )
    await collect(provider, [
      { role: 'assistant', content: [{ id: 'call_1', name: 'read_file', args: {} }] },
    ])

    assert.ok(request)
    assert.deepEqual(request.input, [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    ])
  })
})

describe('ResponsesProvider request body: verbosity and parallel_tool_calls', () => {
  async function bodyFor(
    opts: ConstructorParameters<typeof ResponsesProvider>[1],
  ): Promise<CapturedRequest> {
    const provider = new ResponsesProvider('gpt-5.6-sol', opts)
    let request: CapturedRequest | undefined
    withFakeStream(
      provider,
      (captured) => {
        request = captured
      },
      [{ type: 'response.output_text.delta', delta: 'ok' }],
    )
    await collect(provider)
    assert.ok(request)
    return request
  }

  it('sends text.verbosity when tuned', async () => {
    const body = await bodyFor({ apiKey: 'sk-test', params: { verbosity: 'low' } })
    assert.deepEqual(body.text, { verbosity: 'low' })
    assert.equal(Object.hasOwn(body, 'verbosity'), false)
  })

  it('sends no text field at all by default', async () => {
    const body = await bodyFor({ apiKey: 'sk-test' })
    assert.equal(Object.hasOwn(body, 'text'), false)
  })

  it('sends verbosity alongside reasoning effort', async () => {
    const body = await bodyFor({
      apiKey: 'sk-test',
      params: { verbosity: 'high', reasoning: 'medium' },
    })
    assert.deepEqual(body.text, { verbosity: 'high' })
    assert.equal(body.reasoning?.effort, 'medium')
  })

  it('lets extraBody override it, last', async () => {
    const body = await bodyFor({
      apiKey: 'sk-test',
      params: { verbosity: 'low' },
      extraBody: { text: { verbosity: 'high' } },
    })
    assert.deepEqual(body.text, { verbosity: 'high' })
  })

  it('never sends parallel_tool_calls: the API default (true) is what Copse handles', async () => {
    // The agent loop executes a batch's calls in order and answers them in one
    // tool message, and reasoning replay is keyed to the whole batch (see
    // "replays one reasoning block once for a parallel batch"), so there is
    // nothing for an explicit value to fix. Pinned so a future change has to
    // argue with docs/plans rather than slip in.
    const body = await bodyFor({ apiKey: 'sk-test', params: { verbosity: 'low' } })
    assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false)
  })
})

describe('ResponsesProvider strict tools', () => {
  const tools: LLMTool[] = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'integer' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'device_hub',
      description: 'A root-level union cannot be strict',
      parameters: {
        oneOf: [{ type: 'object', properties: {}, required: [], additionalProperties: false }],
      },
    },
  ]

  async function run(provider: ResponsesProvider): Promise<ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], tools)) {
      chunks.push(chunk)
    }
    return chunks
  }

  function strictFlags(request: CapturedRequest | undefined): Array<[unknown, unknown]> {
    assert.ok(request)
    return request.tools.map((tool) => [tool['name'], tool['strict']])
  }

  it('sends strict only on tools whose schema qualifies when the provider opts in', async () => {
    const provider = new ResponsesProvider('gpt-test', { apiKey: 'k', strictTools: true })
    let request: CapturedRequest | undefined
    withFakeStream(provider, (captured) => (request = captured), [])
    await run(provider)

    assert.deepEqual(strictFlags(request), [
      ['read_file', true],
      ['device_hub', false],
    ])
    const read = at(request?.tools ?? [], 0)
    assert.deepEqual(read['parameters'], {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: ['integer', 'null'] } },
      required: ['path', 'start_line'],
      additionalProperties: false,
    })
    assert.deepEqual(at(request?.tools ?? [], 1)['parameters'], tools[1]?.parameters)
  })

  it('never sends strict for a provider that did not opt in', async () => {
    const provider = new ResponsesProvider('gpt-test', {
      apiKey: 'k',
      baseURL: 'https://third-party.example/v1',
    })
    let request: CapturedRequest | undefined
    withFakeStream(provider, (captured) => (request = captured), [])
    await run(provider)

    assert.deepEqual(strictFlags(request), [
      ['read_file', false],
      ['device_hub', false],
    ])
    assert.deepEqual(at(request?.tools ?? [], 0)['parameters'], tools[0]?.parameters)
  })

  it('maps a null for an optional argument back to absent before the caller sees it', async () => {
    const provider = new ResponsesProvider('gpt-test', { apiKey: 'k', strictTools: true })
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts","start_line":null}',
        },
      },
    ])
    const chunks = await run(provider)
    assert.deepEqual(chunks, [
      { type: 'tool_call', toolCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } },
    ])
  })

  it('leaves malformed arguments to the existing parse-error path', async () => {
    const provider = new ResponsesProvider('gpt-test', { apiKey: 'k', strictTools: true })
    withFakeStream(provider, () => undefined, [
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":',
        },
      },
    ])
    const chunk = at(await run(provider), 0)
    assert.equal(chunk.type, 'tool_call')
    assert.match(JSON.stringify(chunk), /"args":\{\}/)
    assert.match(JSON.stringify(chunk), /Could not parse tool arguments/)
  })

  it('falls back to non-strict once OpenAI rejects a strict schema, and stays there', async () => {
    const provider = new ResponsesProvider('gpt-test', { apiKey: 'k', strictTools: true })
    const requests: CapturedRequest[] = []
    const create: ResponsesProviderForTest['client']['responses']['create'] = async (
      request,
    ): Promise<AsyncIterable<TestEvent>> => {
      requests.push(request)
      if (requests.length === 1) {
        throw Object.assign(
          new Error("400 Invalid schema for function 'read_file': 'required' is required"),
          { status: 400 },
        )
      }
      return streamEvents([{ type: 'response.output_text.delta', delta: 'ok' }])
    }
    Object.defineProperty(provider, 'client', {
      value: { responses: { create } },
      configurable: true,
    })

    assert.deepEqual(await run(provider), [{ type: 'text', text: 'ok' }])
    assert.deepEqual(strictFlags(at(requests, 0)), [
      ['read_file', true],
      ['device_hub', false],
    ])
    assert.deepEqual(strictFlags(at(requests, 1)), [
      ['read_file', false],
      ['device_hub', false],
    ])
    assert.deepEqual(at(at(requests, 1).tools, 0)['parameters'], tools[0]?.parameters)

    await run(provider)
    assert.deepEqual(strictFlags(at(requests, 2)), [
      ['read_file', false],
      ['device_hub', false],
    ])
  })

  it('does not swallow an unrelated 400', async () => {
    const provider = new ResponsesProvider('gpt-test', { apiKey: 'k', strictTools: true })
    const create: ResponsesProviderForTest['client']['responses']['create'] = async () => {
      throw Object.assign(new Error('400 Unsupported parameter: nope'), { status: 400 })
    }
    Object.defineProperty(provider, 'client', {
      value: { responses: { create } },
      configurable: true,
    })
    await assert.rejects(run(provider), /Unsupported parameter/)
  })
})

describe('first-party strict tools with opt-in verbosity', () => {
  for (const verbosity of [undefined, 'low'] as const) {
    it(`preserves discriminator restoration and ambiguous-union fallback with verbosity ${verbosity ?? 'unset'}`, async () => {
      const provider = createProvider('gpt-5.6-sol', { openAiApiKey: 'test-key' }, undefined, {
        params: verbosity === undefined ? {} : { verbosity },
      })
      assert.ok(provider instanceof ResponsesProvider)
      const tools: LLMTool[] = [
        {
          name: 'check',
          description: 'Check a discriminated value',
          parameters: {
            type: 'object',
            properties: {
              check: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['optional'] },
                      note: { type: 'string' },
                    },
                    required: ['kind'],
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['nullable'] },
                      note: { type: ['string', 'null'] },
                    },
                    required: ['kind', 'note'],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ['check'],
            additionalProperties: false,
          },
        },
        {
          name: 'ambiguous',
          description: 'Preserve raw arguments when branches overlap',
          parameters: {
            type: 'object',
            properties: {
              check: {
                anyOf: [
                  { type: 'object', properties: { note: { type: 'string' } }, required: [] },
                  {
                    type: 'object',
                    properties: { note: { type: ['string', 'null'] } },
                    required: ['note'],
                  },
                ],
              },
            },
            required: ['check'],
          },
        },
      ]
      let request: CapturedRequest | undefined
      withFakeStream(
        provider,
        (body) => {
          request = body
        },
        [
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'required-null',
              name: 'check',
              arguments: '{"check":{"kind":"nullable","note":null}}',
            },
          },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'optional-null',
              name: 'check',
              arguments: '{"check":{"kind":"optional","note":null}}',
            },
          },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'ambiguous-null',
              name: 'ambiguous',
              arguments: '{"check":{"note":null}}',
            },
          },
        ],
      )
      const chunks: ProviderStreamChunk[] = []
      for await (const chunk of provider.stream(
        [{ role: 'user', content: 'Check both cases.' }],
        tools,
      ))
        chunks.push(chunk)
      assert.ok(request)
      assert.deepEqual(request.text, verbosity === undefined ? undefined : { verbosity })
      assert.equal(Object.hasOwn(request, 'parallel_tool_calls'), false)
      assert.deepEqual(
        request.tools.map((tool) => [tool['name'], tool['strict']]),
        [
          ['check', true],
          ['ambiguous', false],
        ],
      )
      assert.deepEqual(request.tools[1]?.['parameters'], tools[1]?.parameters)
      assert.deepEqual(chunks, [
        {
          type: 'tool_call',
          toolCall: {
            id: 'required-null',
            name: 'check',
            args: { check: { kind: 'nullable', note: null } },
          },
        },
        {
          type: 'tool_call',
          toolCall: { id: 'optional-null', name: 'check', args: { check: { kind: 'optional' } } },
        },
        {
          type: 'tool_call',
          toolCall: { id: 'ambiguous-null', name: 'ambiguous', args: { check: { note: null } } },
        },
      ])
    })
  }
})
