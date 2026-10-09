import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@copse/std/array-utils.ts'
import { createProvider } from './create-provider.ts'
import { ResponsesProvider, toResponsesInput } from './responses-provider.ts'
import {
  compactionReplayStart,
  withoutProviderState,
  type CompactionIdentity,
} from './provider-state.ts'
import { redactMessages } from './redact-secrets.ts'
import type {
  LLMMessage,
  LLMStreamOptions,
  ProviderCompactionState,
  ProviderStreamChunk,
} from './wire-types.ts'

interface CapturedRequest {
  model: string
  input: unknown
  context_management?: unknown
  store?: boolean
}

type TestEvent =
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'error'; message: string; param: string | null; code: string | null }
  | {
      type: 'response.output_item.done'
      item: { type: 'compaction'; id: string; encrypted_content: string }
    }
  | {
      type: 'response.completed'
      response: {
        output: Array<{ type: string; id?: string; encrypted_content?: string }>
        usage: {
          input_tokens: number
          output_tokens: number
          input_tokens_details: { cached_tokens: number }
        }
      }
    }

const USAGE = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } }

async function* streamEvents(events: readonly TestEvent[]): AsyncIterable<TestEvent> {
  for (const event of events) yield event
}

/** Replace the SDK client with a fake that answers each request from `script`. */
function fakeClient(
  provider: ResponsesProvider,
  script: (request: CapturedRequest, call: number) => readonly TestEvent[] | Error,
): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  const create = async (request: CapturedRequest): Promise<AsyncIterable<TestEvent>> => {
    requests.push(request)
    const outcome = script(request, requests.length - 1)
    if (outcome instanceof Error) throw outcome
    return streamEvents(outcome)
  }
  Object.defineProperty(provider, 'client', {
    value: { responses: { create } },
    configurable: true,
  })
  return requests
}

async function collect(
  provider: ResponsesProvider,
  messages: LLMMessage[],
  options?: LLMStreamOptions,
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, [], undefined, options)) chunks.push(chunk)
  return chunks
}

function compactingProvider(model = 'gpt-5.6-sol'): ResponsesProvider {
  return new ResponsesProvider(model, { apiKey: 'sk-test', serverCompaction: true })
}

function state(overrides: Partial<ProviderCompactionState> = {}): ProviderCompactionState {
  return {
    kind: 'openai-responses-compaction',
    v: 1,
    model: 'gpt-5.6-sol',
    endpoint: '',
    itemId: 'cmp_1',
    encryptedContent: 'opaque-1',
    ...overrides,
  }
}

const OK: readonly TestEvent[] = [
  { type: 'response.output_text.delta', delta: 'ok' },
  { type: 'response.completed', response: { output: [], usage: USAGE } },
]

const IDENTITY: CompactionIdentity = { model: 'gpt-5.6-sol', endpoint: '' }

describe('ResponsesProvider server-side compaction request', () => {
  it('asks for compaction at the threshold the caller supplies', async () => {
    const provider = compactingProvider()
    const requests = fakeClient(provider, () => OK)

    await collect(provider, [{ role: 'user', content: 'hi' }], { compactAtTokens: 120_000.9 })

    assert.deepEqual(at(requests, 0).context_management, [
      { type: 'compaction', compact_threshold: 120_000 },
    ])
  })

  it('sends nothing without a threshold, or when the provider did not opt in', async () => {
    const opted = compactingProvider()
    const optedRequests = fakeClient(opted, () => OK)
    await collect(opted, [{ role: 'user', content: 'hi' }])
    assert.equal(at(optedRequests, 0).context_management, undefined)

    // A compatible third-party endpoint is never assumed to implement it.
    const compat = new ResponsesProvider('gpt-5.6-sol', { apiKey: 'k', baseURL: 'http://x/v1' })
    const compatRequests = fakeClient(compat, () => OK)
    assert.equal(compat.compactionIdentity, undefined)
    await collect(compat, [{ role: 'user', content: 'hi' }], { compactAtTokens: 1_000 })
    assert.equal(at(compatRequests, 0).context_management, undefined)
  })
})

describe('ResponsesProvider compaction item in the stream', () => {
  it('surfaces the compaction item verbatim, once, with its provenance', async () => {
    const provider = compactingProvider()
    const item = { type: 'compaction' as const, id: 'cmp_9', encrypted_content: 'blob==' }
    fakeClient(provider, () => [
      { type: 'response.output_item.done', item },
      { type: 'response.output_text.delta', delta: 'ok' },
      // The final payload repeats it; it must not be emitted twice.
      { type: 'response.completed', response: { output: [item], usage: USAGE } },
    ])

    const chunks = await collect(provider, [{ role: 'user', content: 'hi' }], {
      compactAtTokens: 1_000,
    })

    const states = chunks.filter((chunk) => chunk.type === 'provider_state')
    assert.deepEqual(states, [
      {
        type: 'provider_state',
        state: state({ itemId: 'cmp_9', encryptedContent: 'blob==' }),
      },
    ])
  })

  it('falls back to the completed payload when no item-done event arrived', async () => {
    const provider = compactingProvider()
    fakeClient(provider, () => [
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'compaction', id: 'cmp_2', encrypted_content: 'late' }],
          usage: USAGE,
        },
      },
    ])

    const chunks = await collect(provider, [{ role: 'user', content: 'hi' }])

    assert.equal(chunks.filter((chunk) => chunk.type === 'provider_state').length, 1)
  })

  it('drops a compaction item from a provider that does not replay them', async () => {
    const provider = new ResponsesProvider('gpt-5.6-sol', { apiKey: 'k' })
    fakeClient(provider, () => [
      {
        type: 'response.output_item.done',
        item: { type: 'compaction', id: 'cmp_x', encrypted_content: 'x' },
      },
    ])

    const chunks = await collect(provider, [{ role: 'user', content: 'hi' }])

    assert.deepEqual(chunks, [])
  })
})

describe('compaction replay', () => {
  const history: LLMMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'provider_state', state: state() },
    { role: 'assistant', content: [{ id: 'call_1', name: 'read_file', args: { path: 'a' } }] },
    { role: 'tool', toolResults: [{ toolCallId: 'call_1', result: 'contents' }] },
  ]

  it('replays the item in place of every turn before it, keeping instructions', () => {
    const input = toResponsesInput(history, new Map(), IDENTITY)

    assert.deepEqual(input, [
      { role: 'system', content: 'sys' },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-1' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
    ])
  })

  it('replays only the latest compaction', () => {
    const input = toResponsesInput(
      [
        { role: 'user', content: 'a' },
        { role: 'provider_state', state: state() },
        { role: 'user', content: 'b' },
        { role: 'provider_state', state: state({ itemId: 'cmp_2', encryptedContent: 'opaque-2' }) },
        { role: 'user', content: 'c' },
      ],
      new Map(),
      IDENTITY,
    )

    assert.deepEqual(input, [
      { type: 'compaction', id: 'cmp_2', encrypted_content: 'opaque-2' },
      { role: 'user', content: 'c' },
    ])
  })

  it('never sends an item written for another model or endpoint', () => {
    for (const identity of [
      { model: 'gpt-5.5', endpoint: '' },
      { model: 'gpt-5.6-sol', endpoint: 'http://other/v1' },
    ]) {
      const input = toResponsesInput(history, new Map(), identity)
      assert.equal(JSON.stringify(input).includes('compaction'), false)
      // Nothing was summarised for this model, so its own turns are all still sent.
      assert.equal(JSON.stringify(input).includes('old question'), true)
    }
  })

  it('never sends an item when no identity is supplied', () => {
    const input = toResponsesInput(history)
    assert.equal(JSON.stringify(input).includes('compaction'), false)
    assert.equal(JSON.stringify(input).includes('old question'), true)
  })

  it('survives a JSON round trip, as it does through agent-history.json', () => {
    const restored: unknown = JSON.parse(JSON.stringify({ v: 1, messages: history }))
    assert.ok(typeof restored === 'object' && restored !== null && 'messages' in restored)
    const messages = Array.isArray(restored.messages) ? restored.messages : []
    assert.equal(compactionReplayStart(messages, IDENTITY), 3)
  })
})

describe('compaction rejected by the endpoint', () => {
  const history: LLMMessage[] = [
    { role: 'user', content: 'old question' },
    { role: 'provider_state', state: state() },
    { role: 'user', content: 'new question' },
  ]

  it('retries the same turn without it when the request field is refused', async () => {
    const provider = compactingProvider()
    const requests = fakeClient(provider, (_request, call) =>
      call === 0
        ? Object.assign(new Error('Unknown parameter: context_management'), { status: 400 })
        : OK,
    )

    const chunks = await collect(provider, history, { compactAtTokens: 1_000 })

    assert.equal(requests.length, 2)
    assert.ok(at(requests, 0).context_management)
    assert.equal(at(requests, 1).context_management, undefined)
    // With no replay, the full neutral history goes out: the client-side trim owns it.
    assert.equal(JSON.stringify(at(requests, 1).input).includes('old question'), true)
    assert.equal(JSON.stringify(at(requests, 1).input).includes('"compaction"'), false)
    assert.equal(provider.compactionIdentity, undefined)
    assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text').length, 1)
  })

  it('stays off for the rest of the run after a refusal', async () => {
    const provider = compactingProvider()
    const requests = fakeClient(provider, (_request, call) =>
      call === 0 ? Object.assign(new Error('compaction unsupported'), { status: 400 }) : OK,
    )

    await collect(provider, history, { compactAtTokens: 1_000 })
    await collect(provider, history, { compactAtTokens: 1_000 })

    assert.equal(requests.length, 3)
    assert.equal(at(requests, 2).context_management, undefined)
  })

  it('retries when the refusal arrives inside the stream', async () => {
    const provider = compactingProvider()
    const requests = fakeClient(provider, (_request, call) =>
      call === 0
        ? [
            {
              type: 'error',
              message: 'invalid encrypted_content in compaction item',
              param: null,
              code: null,
            },
          ]
        : OK,
    )

    await collect(provider, history, { compactAtTokens: 1_000 })

    assert.equal(requests.length, 2)
    assert.equal(provider.compactionIdentity, undefined)
  })

  it('does not swallow an unrelated 400', async () => {
    const provider = compactingProvider()
    fakeClient(provider, () => Object.assign(new Error('Invalid model'), { status: 400 }))

    await assert.rejects(collect(provider, history, { compactAtTokens: 1_000 }), /Invalid model/)
    assert.ok(provider.compactionIdentity)
  })
})

describe('createProvider server-side compaction wiring', () => {
  const keys = { openAiApiKey: 'sk-test' }

  it('replays compaction only for the families the capability table enables', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5']) {
      assert.deepEqual(createProvider(model, keys).compactionIdentity, { model, endpoint: '' })
    }
    for (const model of ['o3', 'gpt-4o']) {
      assert.equal(createProvider(model, keys).compactionIdentity, undefined, model)
    }
  })

  it('does not enable it when Chat Completions is forced', () => {
    const provider = createProvider('gpt-5.6-sol', keys, undefined, { forceChatCompletions: true })
    assert.equal(provider.compactionIdentity, undefined)
  })
})

describe('provider state outside the Responses provider', () => {
  const messages: LLMMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'provider_state', state: state() },
    { role: 'assistant', content: 'hello' },
  ]

  it('is stripped for every provider that does not own it', () => {
    assert.deepEqual(withoutProviderState(messages), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('passes redaction untouched, so the blob is not rewritten', () => {
    assert.deepEqual(redactMessages(messages), messages)
  })
})
