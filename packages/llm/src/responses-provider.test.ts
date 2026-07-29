import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ResponsesProvider, toResponsesInput } from './responses-provider.ts'
import type { LLMMessage, ProviderStreamChunk } from './wire-types.ts'

interface CapturedRequest {
  model: string
  input: unknown
  stream: boolean
  tools: Array<Record<string, unknown>>
  max_output_tokens?: number
}

type TestEvent =
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | {
      type: 'response.output_item.done'
      item: { type: 'function_call'; call_id: string; name: string; arguments: string }
    }
  | {
      type: 'response.completed'
      response: {
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
})
