import { describe, it, afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { HostInference } from './host-inference.ts'
import { EgressBroker } from './egress-broker.ts'
import { EgressLink } from './egress-link.ts'
import { parseEgressRule } from './egress-rules.ts'
import { buildHostInferenceProvider } from './guest-host-provider.ts'
import { HOST_INFERENCE_TARGET, INFERENCE_MESSAGE_LIMIT } from './host-inference-wire.ts'
import { ChatGptPlanService } from '../providers/chatgpt-plan-service.ts'
import { createChatGptPlanProvider } from '../providers/chatgpt-plan-provider.ts'
import type { ChatGptPlanState } from '../providers/chatgpt-plan-store.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const echo: LLMProvider = {
  async *stream(messages, tools, _signal, options) {
    assert.deepEqual(messages, [{ role: 'user', content: 'Hello 😀' }])
    assert.equal(tools[0]?.name, 'read_file')
    assert.equal(options?.toolChoice?.name, 'read_file')
    yield { type: 'text', text: 'Hello 😀' }
    yield {
      type: 'tool_call',
      toolCall: { id: 'one', name: 'read_file', args: { path: 'README.md' } },
    }
    yield { type: 'usage', model: 'pinned', inputTokens: 80, outputTokens: 20 }
    yield { type: 'done', stopReason: 'tool_use' }
  },
}
function fixture(
  t: TestContext,
  provider: LLMProvider,
  overrides: {
    tokenCeiling?: number
    wallClockMs?: number
    signal?: AbortSignal
  } = {},
): {
  host: HostInference
  broker: EgressBroker
  link: EgressLink
  provider: LLMProvider
  wire: Buffer[]
} {
  const host = new HostInference({
    provider: async (maximum): Promise<LLMProvider> => {
      assert.ok(maximum <= 4096)
      return provider
    },
    tokenCeiling: 10000,
    wallClockMs: 10000,
    ...overrides,
  })
  const toHost = new PassThrough(),
    toGuest = new PassThrough()
  const wire: Buffer[] = []
  toHost.on('data', (data: unknown) => {
    assert.ok(Buffer.isBuffer(data))
    wire.push(data)
  })
  toGuest.on('data', (data: unknown) => {
    assert.ok(Buffer.isBuffer(data))
    wire.push(data)
  })
  const broker = new EgressBroker({
    rules: [parseEgressRule(HOST_INFERENCE_TARGET)],
    inference: (stream): Promise<void> => host.serve(stream),
  })
  broker.attach(toHost, toGuest)
  const link = new EgressLink(toGuest, toHost)
  t.after(() => {
    host.stop()
    broker.stop()
    toGuest.destroy()
    toHost.destroy()
  })
  return { host, broker, link, provider: buildHostInferenceProvider(link), wire }
}
async function collect(
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<ProviderStreamChunk[]> {
  const result: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(
    [{ role: 'user', content: 'Hello 😀' }],
    [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    signal,
    { toolChoice: { name: 'read_file' }, suppressReasoning: true },
  ))
    result.push(chunk)
  return result
}
async function raw(link: EgressLink, body: string): Promise<string> {
  const stream = await link.open(HOST_INFERENCE_TARGET)
  stream.end(body)
  let result = ''
  for await (const part of stream) result += String(part)
  return result
}
describe('run-scoped host inference', () => {
  it('streams tools, text and usage over stdio with no guest credential', async (t) => {
    const f = fixture(t, echo)
    assert.equal((await collect(f.provider)).length, 4)
    assert.deepEqual(
      f.broker
        .log()
        .filter((e) => e.event === 'connect')
        .map((e) => e.origin),
      [HOST_INFERENCE_TARGET],
    )
    assert.equal(await f.link.requestKey(), '')
  })
  it('rejects extra authority, invalid JSON and oversized input before calling the provider', async (t) => {
    let calls = 0
    const f = fixture(t, {
      async *stream() {
        calls++
        yield { type: 'done' }
      },
    })
    for (const body of [
      'invalid',
      JSON.stringify({ messages: [], tools: [], model: 'other', clientId: 'other' }),
      JSON.stringify({ messages: [], tools: [], url: 'https://other.test' }),
    ])
      assert.match(await raw(f.link, body), /Invalid host inference request/)
    await assert.rejects(raw(f.link, 'x'.repeat(INFERENCE_MESSAGE_LIMIT + 1)))
    assert.equal(calls, 0)
  })
  it('admits more than 128 requests while the run has token and time budget', async (t) => {
    const f = fixture(t, echo, { tokenCeiling: 20000 })
    for (let request = 0; request < 130; request++) {
      assert.equal((await collect(f.provider)).length, 4)
    }
    assert.equal(f.broker.log().filter((entry) => entry.event === 'connect').length, 130)
  })
  it('refuses the next request when the remaining token budget cannot cover it', async (t) => {
    let calls = 0
    const f = fixture(
      t,
      {
        async *stream(messages, tools, signal, options) {
          calls++
          yield* echo.stream(messages, tools, signal, options)
        },
      },
      { tokenCeiling: 110 },
    )
    await collect(f.provider)
    await assert.rejects(collect(f.provider), /token budget/)
    assert.equal(calls, 1)
    assert.equal(f.broker.log().filter((entry) => entry.event === 'connect').length, 2)
  })
  it('enforces the token budget during a request', async (t) => {
    const tokens = fixture(t, echo, { tokenCeiling: 90 })
    await assert.rejects(collect(tokens.provider), /token budget/)
  })
  it('aborts a pending request when the guest cancels', async (t) => {
    let started: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelled = false
    const provider: LLMProvider = {
      async *stream(_m, _t, signal) {
        started()
        assert.ok(signal)
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          )
        })
        signal.throwIfAborted()
        yield { type: 'done' }
      },
    }
    const f = fixture(t, provider),
      controller = new AbortController()
    const request = collect(f.provider, controller.signal)
    await ready
    controller.abort()
    await assert.rejects(request)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, true)
  })
  it('refuses overlapping inference requests and stops requests after run cancellation', async (t) => {
    let start: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      start = resolve
    })
    const controller = new AbortController()
    const f = fixture(
      t,
      {
        async *stream(_m, _t, signal) {
          start()
          assert.ok(signal)
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
          signal.throwIfAborted()
          yield { type: 'done' }
        },
      },
      { signal: controller.signal },
    )
    const first = collect(f.provider)
    await ready
    await assert.rejects(collect(f.provider), /one inference request/)
    controller.abort()
    await assert.rejects(first)
    await assert.rejects(collect(f.provider))
  })
  it('keeps the wall-clock budget while a guest stalls before sending its request', async (t) => {
    const f = fixture(t, echo, { wallClockMs: 30 })
    const stream = await f.link.open(HOST_INFERENCE_TARGET)
    const closed = new Promise<void>((resolve) => stream.on('close', resolve))
    await closed
    assert.equal(stream.destroyed, true)
  })
  it('cannot reach the inference capability on ordinary egress runs', async (t) => {
    const broker = new EgressBroker({ rules: [parseEgressRule(HOST_INFERENCE_TARGET)] }),
      a = new PassThrough(),
      b = new PassThrough()
    broker.attach(a, b)
    const link = new EgressLink(b, a)
    t.after(() => {
      broker.stop()
      a.destroy()
      b.destroy()
    })
    await assert.rejects(link.open(HOST_INFERENCE_TARGET), /no host inference/)
  })
  it('preserves UTF-8 across fragmented responses and refuses incomplete responses', async (t) => {
    const a = new PassThrough(),
      b = new PassThrough()
    let requests = 0
    const broker = new EgressBroker({
      rules: [parseEgressRule(HOST_INFERENCE_TARGET)],
      inference: async (stream): Promise<void> => {
        for await (const _part of stream) {
          // Consume the guest request before writing its response.
        }
        requests++
        const body =
          JSON.stringify({ chunk: { type: 'text', text: '😀' } }) +
          '\n' +
          (requests === 1 ? '{"end":true}\n' : '')
        for (const byte of Buffer.from(body)) stream.write(Buffer.from([byte]))
        stream.end()
      },
    })
    broker.attach(a, b)
    t.after(() => {
      broker.stop()
      a.destroy()
      b.destroy()
    })
    const provider = buildHostInferenceProvider(new EgressLink(b, a))
    assert.deepEqual(await collect(provider), [{ type: 'text', text: '😀' }])
    await assert.rejects(collect(provider), /before completion/)
  })
})

function accountState(): ChatGptPlanState {
  return {
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    activeClientId: 'oaiapp_a',
    accounts: ['a', 'b'].map((name) => ({
      clientId: 'oaiapp_' + name,
      label: name,
      subject: name,
      credentials: {
        accessToken: 'access-secret-' + name,
        refreshToken: 'refresh-secret-' + name,
        idToken: 'id-secret-' + name,
        scopes: ['chatgpt.tokens.use.direct'],
        expiresAt: 0,
      },
    })),
  }
}
function sse(events: unknown[]): Response {
  return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
describe('OAuth stays on the host', () => {
  it('refreshes through the real service, pins the account across picker changes and redacts tokens from the wire', async (t) => {
    let state = accountState(),
      refreshes = 0,
      calls = 0
    const service = new ChatGptPlanService(
      {
        read: (): ChatGptPlanState => structuredClone(state),
        write: (next): void => {
          state = structuredClone(next)
        },
      },
      {
        openBrowser: async (): Promise<void> => {},
        fetch: async (_url, init): Promise<Response> => {
          refreshes++
          assert.match(
            init?.body instanceof URLSearchParams
              ? init.body.toString()
              : typeof init?.body === 'string'
                ? init.body
                : '',
            /refresh-secret-a/,
          )
          return Response.json({
            access_token: 'rotated-access-secret-a',
            refresh_token: 'rotated-refresh-secret-a',
            expires_in: 3600,
            token_type: 'Bearer',
          })
        },
      },
    )
    globalThis.fetch = async (_input, init): Promise<Response> => {
      calls++
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer rotated-access-secret-a',
      )
      return sse([
        { type: 'response.output_text.delta', delta: 'ok rotated-access-secret-a' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 20,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ])
    }
    const f = fixture(
      t,
      createChatGptPlanProvider(
        service,
        { clientId: 'oaiapp_a', model: 'gpt-6.1-sol' },
        'chatgpt-plan:oaiapp_a#gpt-6.1-sol',
        {},
        'thread-test',
      ),
    )
    await collect(f.provider)
    await service.selectAccount('oaiapp_b')
    await collect(f.provider)
    assert.equal(refreshes, 1)
    assert.equal(calls, 2)
    const wire = Buffer.concat(f.wire).toString('utf8')
    for (const secret of [
      'access-secret-a',
      'refresh-secret-a',
      'id-secret-a',
      'access-secret-b',
      'refresh-secret-b',
      'id-secret-b',
    ])
      assert.equal(wire.includes(secret), false)
  })
  it('sign-out interrupts in-flight inference and prevents further account use', async (t) => {
    let state = accountState()
    for (const account of state.accounts)
      if (account.credentials) account.credentials.expiresAt = Date.now() + 3600000
    const service = new ChatGptPlanService(
      {
        read: (): ChatGptPlanState => structuredClone(state),
        write: (next): void => {
          state = structuredClone(next)
        },
      },
      {
        openBrowser: async (): Promise<void> => {},
        fetch: async (): Promise<Response> => new Response(null, { status: 200 }),
      },
    )
    let started: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    globalThis.fetch = async (_input, init): Promise<Response> => {
      started()
      const signal = init?.signal
      assert.ok(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('cancelled'))
          },
          { once: true },
        )
      })
    }
    const f = fixture(
      t,
      createChatGptPlanProvider(
        service,
        { clientId: 'oaiapp_a', model: 'gpt-6.1-sol' },
        'chatgpt-plan:oaiapp_a#gpt-6.1-sol',
        {},
      ),
    )
    const request = collect(f.provider)
    await ready
    await service.signOut('oaiapp_a')
    await assert.rejects(request)
    await assert.rejects(collect(f.provider), /aborted|Reconnect/)
    assert.equal(service.status().accounts.find((a) => a.clientId === 'oaiapp_b')?.connected, true)
  })
})
