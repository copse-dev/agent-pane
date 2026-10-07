import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  OpenAiAgentsApi,
  OpenAiCancellationUnconfirmedError,
  OpenAiCancellationError,
  OpenAiCancellationRecoveryError,
  openAiAgentStateSchema,
  type OpenAiAgentState,
} from './openai-agents-api.ts'

const signal = (): AbortSignal => AbortSignal.timeout(10_000)
const json = (body: unknown): Response => Response.json(body)
const page = (data: unknown[]): Response => json({ data, has_more: false, last_id: null })
const message = (turn: number, text: string): unknown => ({
  id: `msg_${String(turn)}`,
  turn_id: `turn_${String(turn)}`,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
})

function fixture(
  options: {
    lostSubmit?: boolean
    streamFailure?: boolean
    cancelFailure?: boolean
    recoveryFailure?: string
    abort?: AbortController
  } = {},
): {
  api: OpenAiAgentsApi
  requests: Array<{ path: string; method: string; key: string | null }>
  streamClosed: () => number
} {
  const requests: Array<{ path: string; method: string; key: string | null }> = []
  let turn = 0
  let cancelled = false
  let lost = options.lostSubmit ?? false
  let streamClosed = 0
  let cancellationConfirmed = false
  let recoveryFailed = false
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(url.origin, 'https://api.openai.com')
    assert.ok(init)
    const method = init.method ?? 'GET'
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const headers = new Headers(init.headers)
    assert.equal(headers.get('Authorization'), 'Bearer test-key')
    assert.equal(headers.get('OpenAI-Beta'), 'agents=v1')
    assert.equal(init.redirect, 'error')
    requests.push({ path: url.pathname, method, key: headers.get('Idempotency-Key') })
    if (url.pathname === '/v1/agents/sessions') {
      const body = safeJsonParse(
        bodyText,
        decodeWithSchema(z.object({ environment: z.object({ type: z.literal('openai_hosted') }) })),
      )
      assert.ok(body)
      assert.ok(!bodyText.includes('test-key'))
      return json({ id: 'sess_1', status: 'idle', usage: null })
    }
    if (url.pathname.endsWith('/events') && method === 'GET') {
      if (options.streamFailure) return new Response('', { status: 503 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"agent.session.in_progress"}\n\n'),
            )
          },
          cancel(): void {
            streamClosed++
          },
        }),
      )
    }
    if (url.pathname.endsWith('/events') && method === 'POST') {
      if (bodyText.includes('agent.session.input.cancel')) {
        if (options.cancelFailure) return new Response('', { status: 503 })
        assert.equal(init.signal?.aborted, false)
        cancelled = true
      } else {
        turn++
        options.abort?.abort()
        if (lost) {
          lost = false
          throw new TypeError('connection lost after admission')
        }
      }
      return new Response(null, { status: 202 })
    }
    if (
      cancellationConfirmed &&
      !recoveryFailed &&
      url.pathname.endsWith(options.recoveryFailure ?? '/never')
    ) {
      assert.equal(init.signal?.aborted, false)
      recoveryFailed = true
      return new Response('', { status: 503 })
    }
    if (url.pathname.endsWith('/turns'))
      return page(
        Array.from({ length: turn }, (_, i) => ({
          id: `turn_${String(i + 1)}`,
          subagent_id: null,
          status: cancelled ? 'cancelled' : options.abort ? 'in_progress' : 'completed',
          error: null,
        })),
      )
    if (url.pathname.endsWith('/items'))
      return page(Array.from({ length: turn }, (_, i) => message(i + 1, `answer ${String(i + 1)}`)))
    if (url.pathname.endsWith('/artifacts')) return page([])
    if (method === 'DELETE') return json({ deleted: true })
    if (url.pathname.endsWith('/content')) return new Response('file')
    if (cancelled) cancellationConfirmed = true
    return json({
      id: 'sess_1',
      status: cancelled || !options.abort ? 'idle' : 'in_progress',
      usage: {
        input_tokens: turn * 10,
        output_tokens: turn * 5,
        input_tokens_details: { cached_tokens: turn * 2 },
      },
    })
  }
  return {
    api: new OpenAiAgentsApi('test-key', fetchImpl),
    requests,
    streamClosed: (): number => streamClosed,
  }
}

describe('OpenAI Agents API prototype', () => {
  it('persists before sending, subscribes first, continues a session, and accounts only new usage', async () => {
    const { api, requests, streamClosed } = fixture()
    let state = await api.create('gpt-6.1-sol', signal())
    const output: string[] = []
    let saved: OpenAiAgentState | undefined
    const save = (value: OpenAiAgentState): void => {
      saved = structuredClone(value)
    }
    const first = await api.run(state, 'first', {
      signal: signal(),
      save,
      onText: (text) => output.push(text),
    })
    assert.equal(first.text, 'answer 1')
    assert.equal(first.inputTokens, 10)
    assert.equal(first.cacheReadTokens, 2)
    assert.deepEqual(output, ['answer 1\n\n'])
    assert.ok(saved)
    assert.equal(saved.pending, null)
    state = openAiAgentStateSchema.parse(saved) // process restart boundary
    const second = await api.run(state, 'second', { signal: signal(), save, onText: () => {} })
    assert.equal(second.text, 'answer 2')
    assert.equal(second.inputTokens, 10)
    assert.equal(second.outputTokens, 5)
    const posts = requests.filter(
      (request) => request.path.endsWith('/events') && request.method === 'POST',
    )
    assert.equal(posts.length, 2)
    assert.notEqual(posts[0]?.key, posts[1]?.key)
    assert.ok(
      requests.findIndex((r) => r.path.endsWith('/events') && r.method === 'GET') <
        requests.findIndex((r) => r.path.endsWith('/events') && r.method === 'POST'),
    )
    assert.equal(streamClosed(), 2)
    await api.delete(state, signal())
    assert.equal(requests.at(-1)?.method, 'DELETE')
  })

  it('recovers an admitted task after a lost POST response without submitting it again', async () => {
    const { api, requests } = fixture({ lostSubmit: true, streamFailure: true })
    const state = await api.create('gpt-6.1-sol', signal())
    const opts = { signal: signal(), save: (): void => {}, onText: (): void => {} }
    await assert.rejects(api.run(state, 'task', opts), /connection lost/)
    assert.ok(state.pending)
    await assert.rejects(api.run(state, 'different task', opts), /still pending/)
    const result = await api.run(openAiAgentStateSchema.parse(state), 'task', opts)
    assert.equal(result.status, 'completed')
    assert.equal(result.text, 'answer 1')
    assert.equal(
      requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events')).length,
      1,
    )
  })

  it('persists image inputs before submission and recovers them without replay', async () => {
    const { api, requests } = fixture({ lostSubmit: true })
    const state = await api.create('gpt-6.1-sol', signal())
    const images = ['data:image/png;base64,aGVsbG8=']
    let checkpoint: OpenAiAgentState | undefined
    const options = {
      signal: signal(),
      images,
      save: async (value: OpenAiAgentState): Promise<void> => {
        await Promise.resolve()
        checkpoint = structuredClone(value)
      },
      onText: (): void => {},
    }
    await assert.rejects(api.run(state, 'Inspect the image', options), /connection lost/)
    assert.deepEqual(checkpoint?.pending?.images, images)
    assert.ok(checkpoint)
    const restored = openAiAgentStateSchema.parse(checkpoint)
    await assert.rejects(
      api.run(restored, 'Inspect the image', { ...options, images: [] }),
      /still pending/,
    )
    await api.run(restored, 'Inspect the image', options)
    assert.equal(
      requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events')).length,
      1,
    )
  })

  it('confirms cancellation independently of the aborted stream and records usage', async () => {
    const controller = new AbortController()
    const { api, requests } = fixture({ abort: controller })
    const state = await api.create('gpt-6.1-sol', signal())
    const result = await api.run(state, 'task', {
      signal: controller.signal,
      save: (): void => {},
      onText: (): void => {},
    })
    assert.equal(result.status, 'cancelled')
    assert.equal(result.inputTokens, 10)
    assert.equal(state.pending, null)
    assert.equal(
      requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events')).length,
      2,
    )
  })

  it('retains the pending task and reports unconfirmed cancellation', async () => {
    const controller = new AbortController()
    const { api } = fixture({ abort: controller, cancelFailure: true })
    const state = await api.create('gpt-6.1-sol', signal())
    await assert.rejects(
      api.run(state, 'task', {
        signal: controller.signal,
        save: (): void => {},
        onText: (): void => {},
      }),
      OpenAiCancellationUnconfirmedError,
    )
    assert.ok(state.pending)
  })

  for (const endpoint of ['/turns', '/sess_1', '/items', '/artifacts']) {
    it(`surfaces confirmed cancellation recovery failure at ${endpoint} and resumes without replay`, async () => {
      const controller = new AbortController()
      const { api, requests } = fixture({ abort: controller, recoveryFailure: endpoint })
      const state = await api.create('gpt-6.1-sol', signal())
      let saved: OpenAiAgentState | undefined
      const save = (value: OpenAiAgentState): void => {
        saved = structuredClone(value)
      }
      await assert.rejects(
        api.run(state, 'task', { signal: controller.signal, save, onText: () => {} }),
        (error: unknown) => {
          assert.ok(error instanceof OpenAiCancellationRecoveryError)
          assert.ok(error instanceof OpenAiCancellationError)
          assert.equal(error.cancellationConfirmed, true)
          assert.match(error.message, /cancellation was confirmed.*could not be recovered/)
          assert.ok(error.cause instanceof Error)
          assert.match(error.cause.message, /HTTP 503/)
          return true
        },
      )
      assert.ok(saved?.pending)
      assert.deepEqual(state, saved)
      assert.equal(state.usageInput, 0)
      const result = await api.run(openAiAgentStateSchema.parse(saved), 'task', {
        signal: signal(),
        save,
        onText: () => {},
      })
      assert.equal(result.status, 'cancelled')
      assert.equal(result.inputTokens, 10)
      assert.equal(saved.pending, null)
      assert.equal(requests.filter((r) => r.method === 'POST' && r.key !== null).length, 1)
    })
  }

  it('rejects mismatched artifact lengths and oversized metadata', async () => {
    const { api } = fixture()
    const state = await api.create('gpt-6.1-sol', signal())
    assert.equal(
      Buffer.from(
        await api.download(
          state,
          { id: 'a', path: '/workspace/outputs/a.txt', size_bytes: 4, turn_id: 't' },
          signal(),
        ),
      ).toString(),
      'file',
    )
    await assert.rejects(
      api.download(state, { id: 'a', path: '../../escape', size_bytes: 3, turn_id: 't' }, signal()),
      /size did not match/,
    )
    await assert.rejects(
      api.download(
        state,
        { id: 'a', path: '/a', size_bytes: 11 * 1024 * 1024, turn_id: 't' },
        signal(),
      ),
      /10 MiB/,
    )
  })
})

it('uploads a bounded source file and passes deterministic setup to a verified environment', async () => {
  let connected = true
  const api = new OpenAiAgentsApi('test-key', async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
    assert.ok(init)
    assert.equal(init.redirect, 'error')
    if (url.pathname === '/v1/files') {
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('purpose'), 'user_data')
      const file = init.body.get('file')
      assert.ok(file instanceof Blob)
      assert.equal(await file.text(), 'bundle')
      return json({ id: 'uploaded-file' })
    }
    if (url.pathname === '/v1/agents/sessions') {
      assert.ok(typeof init.body === 'string')
      const request = safeJsonParse(
        init.body,
        decodeWithSchema(
          z.object({
            environment: z.object({
              files: z.array(z.object({ file_id: z.string(), path: z.string() })),
              setup_commands: z.array(z.object({ command: z.string() })),
            }),
          }),
        ),
      )
      assert.equal(request?.environment.files[0]?.file_id, 'uploaded-file')
      assert.equal(request.environment.setup_commands[0]?.command, 'verify-snapshot')
      return json({ id: 'session', status: 'idle', environment: { id: 'env' } })
    }
    assert.equal(url.pathname, '/v1/agents/environments/env')
    return json({ status: connected ? 'connected' : 'failed' })
  })
  const file = await api.uploadSource(Buffer.from('bundle'), signal())
  const state = await api.create('gpt-6.1-sol', signal(), {
    type: 'openai_hosted',
    files: [{ type: 'file_id', file_id: file, path: '/workspace/inputs/source.bundle' }],
    setup_commands: [{ command: 'verify-snapshot' }],
  })
  assert.equal(state.environmentId, 'env')
  await api.waitForEnvironment(state, signal())
  connected = false
  await assert.rejects(api.waitForEnvironment(state, signal()), /setup failed/)
  await assert.rejects(api.uploadSource(new Uint8Array(50 * 1024 * 1024 + 1), signal()), /50 MiB/)
})
