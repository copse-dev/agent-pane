import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { ResponsesProvider } from './responses-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { AnthropicProvider } from './anthropic-provider.ts'
import { withPromptCatalog, PromptCacheDiagnostics } from './prompt-cache-diagnostics.ts'
import { costForModelUsage } from './estimate-cost.ts'
import type {
  LLMMessage,
  LLMProvider,
  PromptCatalogFootprint,
  ProviderStreamChunk,
} from './wire-types.ts'

const catalog: PromptCatalogFootprint = {
  catalogHash: 'a'.repeat(64),
  advertisedSkills: 12,
  userSkills: 8,
  utf8Bytes: 4096,
  userEntryUtf8Bytes: 2048,
  approximateTokens: 1024,
}
const messages: LLMMessage[] = [
  { role: 'system', content: 'Private system instructions' },
  { role: 'user', content: 'Private user request' },
]
const recordSchema = z.record(z.string(), z.unknown())

function capture(t: TestContext): { tag: string; data: Record<string, unknown> }[] {
  const previous = process.env['COPSE_DEBUG_PROMPT_CACHE']
  process.env['COPSE_DEBUG_PROMPT_CACHE'] = '1'
  t.after(() => {
    if (previous === undefined) delete process.env['COPSE_DEBUG_PROMPT_CACHE']
    else process.env['COPSE_DEBUG_PROMPT_CACHE'] = previous
  })
  const logs: { tag: string; data: Record<string, unknown> }[] = []
  t.mock.method(console, 'error', (tag: unknown, body: unknown) => {
    if (tag !== '[prompt-cache-dispatch]' && tag !== '[prompt-cache]') return
    assert.equal(typeof body, 'string')
    const data = safeJsonParse(String(body), decodeWithSchema(recordSchema))
    assert.ok(data)
    logs.push({ tag, data })
  })
  return logs
}

function sse(events: unknown[]): Response {
  return new Response(
    events
      .map((event) => {
        const name =
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          typeof event.type === 'string'
            ? `event: ${event.type}\n`
            : ''
        return `${name}data: ${JSON.stringify(event)}\n\n`
      })
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

function responseEvents(details: unknown): unknown[] {
  return [
    {
      type: 'response.completed',
      response: {
        id: 'response-test',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: details },
      },
    },
  ]
}

async function drain(provider: LLMProvider, signal?: AbortSignal): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, [], signal)) chunks.push(chunk)
  return chunks
}

describe('dispatched prompt measurement', () => {
  it('joins completed and failed SDK dispatches without changing serialized requests', async (t) => {
    const logs = capture(t)
    const bodies: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.ok(typeof init.body === 'string')
      bodies.push(init.body)
      return sse(responseEvents({ cached_tokens: 0, cache_write_tokens: 900 }))
    })
    const provider = new ResponsesProvider('gpt-6.1-sol', {
      apiKey: 'private-key',
      promptCacheKey: 'private-thread',
    })
    delete process.env['COPSE_DEBUG_PROMPT_CACHE']
    await drain(provider)
    assert.equal(logs.length, 0)
    process.env['COPSE_DEBUG_PROMPT_CACHE'] = '1'
    const chunks = await drain(withPromptCatalog(provider, catalog))
    assert.equal(bodies[0], bodies[1])
    assert.equal(logs.length, 2)
    const start = logs[0]?.data
    const end = logs[1]?.data
    assert.ok(start && end)
    assert.equal(start['requestId'], end['requestId'])
    assert.equal(start['attemptKind'], 'sdk-dispatch')
    assert.deepEqual(end['catalog'], catalog)
    assert.equal(end['outcome'], 'completed')
    assert.equal(end['cacheReadTokens'], 0)
    assert.equal(end['cacheCreationTokens'], 900)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.ok(usage)
    assert.equal(usage.cacheCreationTokens, 900)
    assert.ok(Math.abs(costForModelUsage('gpt-6.1-sol', usage) - 0.00255) < 1e-12)
    assert.doesNotMatch(JSON.stringify(logs), /Private|private-key|private-thread|api.openai.com/)

    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'private failure', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    )
    await assert.rejects(
      drain(withPromptCatalog(new ResponsesProvider('gpt-6.1-sol', { apiKey: 'test' }), catalog)),
    )
    assert.equal(logs.at(-1)?.data['outcome'], 'failed')
    assert.equal(logs.at(-1)?.data['cacheReadTokens'], null)
    assert.equal(logs.at(-1)?.data['requestId'], logs.at(-2)?.data['requestId'])
    assert.doesNotMatch(JSON.stringify(logs), /private failure/)
  })

  it('keeps missing, invalid and zero Responses cache counts distinct', async (t) => {
    const logs = capture(t)
    for (const [details, expectedRead, expectedWrite] of [
      [undefined, null, null],
      [{}, null, null],
      [{ cached_tokens: 0, cache_write_tokens: 0 }, 0, 0],
      [{ cached_tokens: -1, cache_write_tokens: '900' }, null, null],
      [{ cached_tokens: 600, cache_write_tokens: 300 }, 600, 300],
    ] as const) {
      t.mock.method(globalThis, 'fetch', async () => sse(responseEvents(details)))
      await drain(new ResponsesProvider('gpt-test', { apiKey: 'test' }))
      assert.equal(logs.at(-1)?.data['cacheReadTokens'], expectedRead)
      assert.equal(logs.at(-1)?.data['cacheCreationTokens'], expectedWrite)
    }
  })

  it('records completion when the agent stops consuming at the Responses done chunk', async (t) => {
    const logs = capture(t)
    t.mock.method(globalThis, 'fetch', async () => sse(responseEvents({ cached_tokens: 0 })))
    const provider = withPromptCatalog(
      new ResponsesProvider('gpt-test', { apiKey: 'test' }),
      catalog,
    )
    for await (const chunk of provider.stream(messages, [])) {
      if (chunk.type === 'done') break
    }
    assert.equal(logs.length, 2)
    assert.equal(logs.at(-1)?.data['outcome'], 'completed')
    assert.equal(logs.at(-1)?.data['inputTokens'], 1000)
    assert.equal(logs.at(-1)?.data['cacheReadTokens'], 0)
  })

  it('hashes each Responses fallback after its request transformations', async (t) => {
    const logs = capture(t)
    const requests: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.ok(typeof init.body === 'string')
      const request = safeJsonParse(init.body, decodeWithSchema(recordSchema))
      assert.ok(request)
      requests.push(request)
      if (requests.length === 1)
        return new Response(
          JSON.stringify({
            error: {
              message: 'Invalid schema for function read',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      return sse(responseEvents({ cached_tokens: 0 }))
    })
    const provider = withPromptCatalog(
      new ResponsesProvider('gpt-test', { apiKey: 'test', strictTools: true }),
      catalog,
    )
    for await (const _ of provider.stream(messages, [
      {
        name: 'read',
        description: 'Read',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ])) {
      /* drain */
    }
    const endings = logs.filter((log) => log.tag === '[prompt-cache]').map((log) => log.data)
    assert.deepEqual(
      endings.map((record) => record['outcome']),
      ['failed', 'completed'],
    )
    assert.notEqual(endings[0]?.['requestId'], endings[1]?.['requestId'])
    assert.notEqual(endings[0]?.['toolsHash'], endings[1]?.['toolsHash'])
    assert.equal(endings[1]?.['toolsChanged'], true)
    assert.deepEqual(
      endings.map((record) => record['catalog']),
      [catalog, catalog],
    )
  })

  it('isolates interleaved catalogs and leaves auxiliary requests unlabelled', async (t) => {
    const logs = capture(t)
    t.mock.method(globalThis, 'fetch', async () => sse(responseEvents({ cached_tokens: 0 })))
    const raw = new ResponsesProvider('gpt-test', { apiKey: 'test', promptCacheKey: 'interleaved' })
    const other = { ...catalog, advertisedSkills: 1, catalogHash: 'b'.repeat(64) }
    await Promise.all([
      drain(withPromptCatalog(raw, catalog)),
      drain(withPromptCatalog(raw, other)),
      drain(raw),
    ])
    for (const end of logs.filter((log) => log.tag === '[prompt-cache]')) {
      const start = logs.find(
        (log) =>
          log.tag === '[prompt-cache-dispatch]' && log.data['requestId'] === end.data['requestId'],
      )
      assert.deepEqual(end.data['catalog'], start?.data['catalog'])
    }
    assert.deepEqual(
      logs.filter((log) => log.tag === '[prompt-cache-dispatch]').map((log) => log.data['catalog']),
      [catalog, other, null],
    )
    assert.equal(withPromptCatalog(raw, undefined), raw)
  })

  for (const transport of ['anthropic', 'chat-completions', 'responses'] as const) {
    it(`records consumer interruption for ${transport}`, async (t) => {
      const logs = capture(t)
      const events =
        transport === 'anthropic'
          ? [
              {
                type: 'message_start',
                message: {
                  id: 'message-test',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-4-6',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 0 },
                },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'hello' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]
          : transport === 'responses'
            ? [{ type: 'response.output_text.delta', delta: 'hello' }]
            : [{ choices: [{ delta: { content: 'hello' } }] }]
      t.mock.method(globalThis, 'fetch', async () => sse(events))
      const provider =
        transport === 'anthropic'
          ? new AnthropicProvider('claude-sonnet-4-6', { apiKey: 'test' })
          : transport === 'responses'
            ? new ResponsesProvider('gpt-test', { apiKey: 'test' })
            : new OpenAIProvider('gpt-test', { apiKey: 'test' })
      for await (const _ of withPromptCatalog(provider, catalog).stream(messages, [])) break
      assert.equal(logs.length, 2)
      assert.equal(logs.at(-1)?.data['outcome'], 'interrupted')
      assert.deepEqual(logs.at(-1)?.data['catalog'], catalog)
    })
  }

  it('finishes a diagnostic at most once', (t) => {
    const logs = capture(t)
    const finish = new PromptCacheDiagnostics('test', 'model', 'endpoint').begin('system', [])
    finish(null, 'cancelled')
    finish({ inputTokens: 1, outputTokens: 1 })
    assert.equal(logs.length, 2)
    assert.equal(logs.at(-1)?.data['outcome'], 'cancelled')
  })
})
