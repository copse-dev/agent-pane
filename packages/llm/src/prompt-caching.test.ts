import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { isRecord } from '@copse/std/unknown-value.ts'
import { at } from '@copse/std/array-utils.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { AnthropicProvider } from './anthropic-provider.ts'
import { PromptCacheDiagnostics } from './prompt-cache-diagnostics.ts'
import { createExtraCloudProvider, createOpenRouterProvider } from './create-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { costForModelUsage } from './estimate-cost.ts'
import type { LLMMessage, LLMProvider, LLMTool, ProviderStreamChunk } from './wire-types.ts'

const ephemeral = { type: 'ephemeral' }
const tools: LLMTool[] = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'search', description: 'Search files', parameters: { type: 'object' } },
]

async function requestFor(
  provider: LLMProvider,
  messages: LLMMessage[],
  requestTools: LLMTool[] = tools,
  usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 10 },
): Promise<{ request: Record<string, unknown>; chunks: ProviderStreamChunk[] }> {
  let request: Record<string, unknown> | undefined
  const create = (body: Record<string, unknown>): AsyncIterable<unknown> => {
    request = body
    return (async function* (): AsyncGenerator {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage }
    })()
  }
  Object.defineProperty(provider, 'client', {
    value: { chat: { completions: { create } }, responses: { create } },
    configurable: true,
  })
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, requestTools)) chunks.push(chunk)
  assert.ok(request)
  return { request, chunks }
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value))
  return value.map((entry: unknown) => {
    assert.ok(isRecord(entry))
    return entry
  })
}

function breakpointCount(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce<number>((sum, child: unknown) => sum + breakpointCount(child), 0)
  if (!isRecord(value)) return 0
  return (
    (Object.hasOwn(value, 'cache_control') ? 1 : 0) +
    Object.values(value).reduce<number>((sum, child) => sum + breakpointCount(child), 0)
  )
}

describe('OpenRouter Claude prompt caching (#1286)', () => {
  it('serializes the extensions through the real SDK and reads the SSE usage response', async (t) => {
    let request: unknown
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      assert.ok(typeof init.body === 'string')
      request = safeJsonParse(init.body)
      return new Response(
        `data: ${JSON.stringify({
          id: 'completion-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'anthropic/claude-sonnet-4.6',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
          },
        })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const provider = createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test', 'thread-sdk')
    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'Stable instructions' },
        { role: 'user', content: 'Hello' },
      ],
      tools,
    ))
      chunks.push(chunk)
    assert.equal(breakpointCount(request), 3)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.equal(usage?.cacheReadTokens, 600)
    assert.equal(usage.cacheCreationTokens, 300)
  })

  it('caches tools, system and conversation before volatile operator instructions', async () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: 'Read the project' },
      { role: 'system', content: 'Turn-specific steering' },
      { role: 'developer', content: 'More volatile context' },
    ]
    const before = structuredClone({ messages, tools })
    const { request } = await requestFor(
      createOpenRouterProvider('anthropic/claude-opus-4.8', 'test', 'thread-a'),
      messages,
    )
    const sent = records(request['messages'])
    assert.deepEqual(records(sent[0]?.['content']).at(-1)?.['cache_control'], ephemeral)
    assert.deepEqual(records(sent[1]?.['content']).at(-1)?.['cache_control'], ephemeral)
    assert.equal(sent[2]?.['content'], 'Turn-specific steering')
    assert.equal(sent[3]?.['content'], 'More volatile context')
    const sentTools = records(request['tools'])
    assert.equal(sentTools[0]?.['cache_control'], undefined)
    assert.deepEqual(sentTools[1]?.['cache_control'], ephemeral)
    assert.equal(breakpointCount(request), 3)
    assert.equal(request['prompt_cache_key'], 'thread-a')
    assert.deepEqual(request['provider'], {
      require_parameters: true,
      zdr: true,
      data_collection: 'deny',
    })
    assert.deepEqual({ messages, tools }, before, 'caller-owned history and schemas stay unchanged')
  })

  it('caches the last of twelve parallel tool results before steering, preserving tool ids', async () => {
    const provider = createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test')
    const opening: LLMMessage[] = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: 'Read the project' },
    ]
    const first = await requestFor(provider, opening)
    const calls = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${String(index)}`,
      name: 'read',
      args: { path: `file-${String(index)}.ts` },
    }))
    const second = await requestFor(provider, [
      ...opening,
      { role: 'assistant', content: calls },
      {
        role: 'tool',
        toolResults: calls.map((call) => ({ toolCallId: call.id, result: 'file contents' })),
      },
      { role: 'system', content: 'New steering' },
    ])
    const sent = records(second.request['messages'])
    assert.deepEqual(records(first.request['messages'])[0], sent[0])
    assert.deepEqual(records(sent.at(-2)?.['content']).at(-1), {
      type: 'text',
      text: 'file contents',
      cache_control: ephemeral,
    })
    assert.equal(sent.at(-2)?.['tool_call_id'], 'tool-11')
    assert.equal(sent.at(-1)?.['content'], 'New steering')
    assert.ok(breakpointCount(second.request) <= 4)
  })

  it('keeps image content and detail while caching the last reusable text block', async () => {
    const { request } = await requestFor(
      createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test'),
      [
        {
          role: 'user',
          content: [
            { type: 'image', dataUrl: 'data:image/png;base64,image', detail: 'high' },
            { type: 'text', text: 'Explain this' },
          ],
        },
      ],
      [],
    )
    const content = records(records(request['messages'])[0]?.['content'])
    assert.deepEqual(content[0], {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,image', detail: 'high' },
    })
    assert.deepEqual(content[1], { type: 'text', text: 'Explain this', cache_control: ephemeral })
    assert.equal(breakpointCount(request), 1)
  })

  it('leaves non-Claude routes and arbitrary compatible endpoints unchanged', async () => {
    for (const provider of [
      createOpenRouterProvider('openai/gpt-4o', 'test'),
      new OpenAIProvider('anthropic/claude-sonnet-4.6', {
        apiKey: 'test',
        baseURL: 'http://localhost:1234/v1',
      }),
    ]) {
      const { request } = await requestFor(provider, [{ role: 'user', content: 'Hello' }])
      assert.deepEqual(request['messages'], [{ role: 'user', content: 'Hello' }])
      assert.equal(breakpointCount(request), 0)
    }
  })

  it('does not create empty text blocks or put cache controls on operator-only input', async () => {
    for (const messages of [
      [],
      [{ role: 'user', content: '' }],
      [{ role: 'user', content: [] }],
      [{ role: 'assistant', content: [] }],
      [{ role: 'system', content: '' }],
    ] satisfies LLMMessage[][]) {
      const { request } = await requestFor(
        createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test'),
        messages,
        [],
      )
      assert.equal(breakpointCount(request), 0)
    }
    const { request } = await requestFor(
      createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test'),
      [{ role: 'system', content: 'Only the system' }],
      [],
    )
    assert.equal(breakpointCount(request), 1)
  })

  it('does not turn malformed or missing cache-write metrics into usage', async () => {
    for (const value of [undefined, null, '300', -1, Infinity, NaN]) {
      const { chunks } = await requestFor(
        createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test'),
        [{ role: 'user', content: 'Hello' }],
        [],
        {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cache_write_tokens: value },
        },
      )
      assert.equal(chunks.find((chunk) => chunk.type === 'usage')?.cacheCreationTokens, undefined)
    }
  })

  it('propagates cache writes and reads into usage and the cost calculation', async () => {
    const provider = createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'test')
    const { chunks } = await requestFor(provider, [{ role: 'user', content: 'Hello' }], [], {
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.ok(usage)
    assert.equal(usage.inputTokens, 1000, 'cache buckets are subsets, not additional input')
    assert.equal(usage.cacheReadTokens, 600)
    assert.equal(usage.cacheCreationTokens, 300)
    assert.ok(provider instanceof OpenAIProvider)
    assert.equal(provider.lastUsage?.cacheCreationTokens, 300)
    const cost = costForModelUsage('openrouter:anthropic/claude-sonnet-4.6', usage, {
      'openrouter:anthropic/claude-sonnet-4.6': {
        inputPricePerMTok: 3,
        outputPricePerMTok: 15,
        cacheReadPricePerMTok: 0.3,
        cacheCreationPricePerMTok: 3.75,
      },
    })
    assert.ok(Math.abs(cost - 0.001755) < 1e-12)
  })
})

function captureDiagnostics(t: TestContext, enabled: boolean): Record<string, unknown>[] {
  const previous = process.env['COPSE_DEBUG_PROMPT_CACHE']
  process.env['COPSE_DEBUG_PROMPT_CACHE'] = enabled ? '1' : '0'
  t.after(() => {
    if (previous === undefined) delete process.env['COPSE_DEBUG_PROMPT_CACHE']
    else process.env['COPSE_DEBUG_PROMPT_CACHE'] = previous
  })
  const output: Record<string, unknown>[] = []
  t.mock.method(console, 'error', (prefix: unknown, serialized: unknown) => {
    assert.equal(prefix, '[prompt-cache]')
    assert.equal(typeof serialized, 'string')
    const parsed = safeJsonParse(String(serialized))
    assert.ok(isRecord(parsed))
    output.push(parsed)
  })
  return output
}

describe('prompt-cache diagnostics (#1286)', () => {
  it('compares actual system/tool hashes across provider recreation without logging content', async (t) => {
    const logs = captureDiagnostics(t, true)
    for (const [system, requestTools] of [
      ['private prompt', tools],
      ['private prompt', tools],
      ['changed private prompt', tools.slice(0, 1)],
    ] as const) {
      await requestFor(
        createOpenRouterProvider('anthropic/claude-sonnet-4.6', 'secret-api-key', 'private-thread'),
        [
          { role: 'system', content: system },
          { role: 'user', content: 'private question' },
          { role: 'system', content: `volatile steering ${String(logs.length)}` },
        ],
        requestTools,
        {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
        },
      )
    }
    assert.equal(logs.length, 3)
    assert.deepEqual(
      logs.map((log) => log['systemChanged']),
      [null, false, true],
    )
    assert.deepEqual(
      logs.map((log) => log['toolsChanged']),
      [null, false, true],
    )
    assert.equal(at(logs, 1)['cacheReadTokens'], 600)
    assert.equal(at(logs, 1)['cacheCreationTokens'], 300)
    assert.equal(new Set(logs.map((log) => log['scopeHash'])).size, 1)
    assert.equal(new Set(logs.map((log) => log['requestId'])).size, 3)
    const serialized = JSON.stringify(logs)
    for (const secret of [
      'private',
      'secret-api-key',
      'Read a file',
      'Search files',
      'openrouter.ai',
    ])
      assert.equal(serialized.includes(secret), false)
  })

  it('reports Anthropic cache buckets against its rendered system prompt', async (t) => {
    const logs = captureDiagnostics(t, true)
    const provider = new AnthropicProvider('claude-sonnet-4-6', {
      apiKey: 'test',
      promptCacheKey: 'anthropic-thread',
    })
    Object.defineProperty(provider, 'client', {
      value: {
        messages: {
          stream: async function* (): AsyncGenerator {
            yield {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 100,
                  output_tokens: 1,
                  cache_read_input_tokens: 600,
                  cache_creation_input_tokens: 300,
                },
              },
            }
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 10 },
            }
          },
        },
      },
    })
    for await (const _ of provider.stream(
      [
        { role: 'system', content: 'private instructions' },
        { role: 'user', content: 'Hello' },
      ],
      tools,
    )) {
      // Drain the production stream so the diagnostic sees the final usage.
    }
    assert.equal(logs.length, 1)
    assert.equal(at(logs, 0)['inputTokens'], 1000)
    assert.equal(at(logs, 0)['outputTokens'], 10)
    assert.equal(at(logs, 0)['cacheReadTokens'], 600)
    assert.equal(at(logs, 0)['cacheCreationTokens'], 300)
  })

  it('captures comparison state at dispatch and distinguishes threads and endpoints', (t) => {
    const logs = captureDiagnostics(t, true)
    const a = new PromptCacheDiagnostics('test', 'model', 'endpoint-a', 'concurrent-a')
    const finishA = a.begin('first', [])
    const finishB = a.begin('second', [])
    finishB(null)
    finishA({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })
    new PromptCacheDiagnostics('test', 'model', 'endpoint-b', 'concurrent-a').begin(
      'third',
      [],
    )(null)
    new PromptCacheDiagnostics('test', 'model', 'endpoint-a', 'concurrent-b').begin(
      'third',
      [],
    )(null)
    assert.deepEqual(
      logs.map((log) => log['systemChanged']),
      [true, null, null, null],
    )
    assert.equal(at(logs, 0)['cacheReadTokens'], null, 'unreported is different from zero')
    assert.equal(at(logs, 1)['cacheReadTokens'], 0)
    assert.notEqual(at(logs, 0)['systemHash'], at(logs, 1)['systemHash'])
  })

  it('bounds comparison history and performs no serialization when disabled', (t) => {
    const logs = captureDiagnostics(t, true)
    const first = new PromptCacheDiagnostics('test', 'model', 'endpoint', 'eviction-first')
    first.begin('prompt', [])(null)
    for (let i = 0; i < 128; i++)
      new PromptCacheDiagnostics('test', 'model', 'endpoint', `eviction-${String(i)}`).begin(
        'prompt',
        [],
      )(null)
    first.begin('prompt', [])(null)
    assert.equal(logs.at(-1)?.['systemChanged'], null)
    process.env['COPSE_DEBUG_PROMPT_CACHE'] = '0'
    const count = logs.length
    const unserializable = {
      toJSON: (): never => {
        throw new Error('must not serialize')
      },
    }
    first.begin(unserializable, unserializable)(null)
    assert.equal(logs.length, count)
  })
})

describe('extra-provider cache routing (#1286)', () => {
  for (const apiStyle of ['chat-completions', 'responses'] as const) {
    it(`forwards thread cache hints to cloud ${apiStyle}, but omits them locally`, async () => {
      for (const local of [false, true]) {
        const provider = createExtraCloudProvider(
          { baseUrl: 'http://localhost:1234/v1', local, apiStyle },
          'some-model',
          'test',
          [],
          {},
          'thread-extra',
        )
        const { request } = await requestFor(provider, [{ role: 'user', content: 'Hello' }], [])
        assert.equal(request['prompt_cache_key'], local ? undefined : 'thread-extra')
      }
    })
  }
})
