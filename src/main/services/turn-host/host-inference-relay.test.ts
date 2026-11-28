import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { HostInferenceRelay } from './host-inference-relay.ts'
import { TurnHostLink } from './turn-host-link.ts'
import {
  MAX_OPEN_INFERENCES,
  type AppToHost,
  type HostInferRequest,
  type HostToApp,
  type TurnHostClient,
  type TurnHostConnection,
} from './turn-host-protocol.ts'

const VERSION = '1.0.0'

type Infer = (request: HostInferRequest, signal: AbortSignal) => AsyncIterable<ProviderStreamChunk>

/**
 * A worker's relay and an app's link joined by an in-memory line, as the
 * forwarded socket joins them. Returns the app's line, and what crossed it.
 */
async function joined(
  relay: HostInferenceRelay,
  infer: Infer,
  hostVersion = VERSION,
): Promise<{ app: TurnHostClient; toApp: HostToApp[]; drop: () => void }> {
  const toApp: HostToApp[] = []
  let deliver: (message: HostToApp) => void = () => undefined
  let close: () => void = () => undefined
  let open = true
  const app: TurnHostClient = {
    join: () => undefined,
    send: (message) => {
      toApp.push(message)
      if (open)
        queueMicrotask(() => {
          deliver(message)
        })
    },
  }
  const link = new TurnHostLink({
    version: VERSION,
    connect: (onMessage, onClose): Promise<TurnHostConnection> => {
      deliver = onMessage
      close = onClose
      return Promise.resolve({
        send: (message: AppToHost): void => {
          if (!open) return
          if (message.t === 'hello')
            queueMicrotask(() => {
              onMessage({ t: 'hello', version: hostVersion, protocol: 3, pid: 1 })
            })
          else if (message.t === 'attach') relay.attach(app)
          else if (
            message.t === 'infer-chunk' ||
            message.t === 'infer-end' ||
            message.t === 'infer-error'
          )
            relay.receive(message, app)
        },
        close: (): void => undefined,
      })
    },
    readRecord: (): Promise<null> => Promise.resolve(null),
    isAlive: (): boolean => true,
    settleUncertain: (): Promise<void> => Promise.resolve(),
    infer,
  })
  assert.equal(await link.ensureConnected(), hostVersion === VERSION)
  return {
    app,
    toApp,
    drop: (): void => {
      open = false
      close()
      relay.left(app)
    },
  }
}

async function collect(
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [], signal))
    chunks.push(chunk)
  return chunks
}

describe("a worker's model calls, made by the app", () => {
  it("streams the app's reply, built for the model and settings the worker named", async () => {
    const relay = new HostInferenceRelay()
    const asked: HostInferRequest[] = []
    await joined(relay, async function* (request) {
      asked.push(request)
      await Promise.resolve()
      yield { type: 'text', text: 'Hel' }
      yield { type: 'text', text: 'lo' }
    })
    const chunks = await collect(
      relay.provider('claude-sonnet-4-6', 'thread-1', { reasoning: 'high', maxOutputTokens: 900 }),
    )
    assert.deepEqual(chunks, [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
    assert.equal(asked.length, 1)
    const [request] = asked
    assert.ok(request)
    assert.equal(request.model, 'claude-sonnet-4-6')
    assert.equal(request.promptCacheKey, 'thread-1')
    assert.deepEqual(request.providerOptions, { reasoning: 'high', maxOutputTokens: 900 })
  })

  it("fails the call with the app's error", async () => {
    const relay = new HostInferenceRelay()
    await joined(relay, async function* () {
      await Promise.resolve()
      yield* []
      throw new Error('No API key for Anthropic')
    })
    await assert.rejects(collect(relay.provider('claude-sonnet-4-6')), /No API key for Anthropic/)
  })

  it('waits for an app to attach before it asks', async () => {
    const relay = new HostInferenceRelay()
    const call = collect(relay.provider('m'))
    await joined(relay, async function* () {
      await Promise.resolve()
      yield { type: 'text', text: 'late' }
    })
    assert.deepEqual(await call, [{ type: 'text', text: 'late' }])
  })

  it('stops the app paying for a call the worker stopped', async () => {
    const relay = new HostInferenceRelay()
    const stopped = Promise.withResolvers<undefined>()
    const { toApp } = await joined(relay, async function* (_request, signal) {
      yield { type: 'text', text: 'first' }
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })
      stopped.resolve(undefined)
    })
    const controller = new AbortController()
    for await (const chunk of relay.provider('m').stream([], [], controller.signal)) {
      assert.deepEqual(chunk, { type: 'text', text: 'first' })
      break
    }
    await stopped.promise
    assert.ok(toApp.some((message) => message.t === 'infer-cancel'))
  })

  it('fails a call whose app went away mid-reply', async () => {
    const relay = new HostInferenceRelay()
    const started = Promise.withResolvers<undefined>()
    const { drop } = await joined(relay, async function* (_request, signal) {
      yield { type: 'text', text: 'partial' }
      started.resolve(undefined)
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })
    })
    const call = collect(relay.provider('m'))
    await started.promise
    drop()
    await assert.rejects(call, /went away/)
  })

  it('a call stopped while it waits for an app never reaches one', async () => {
    const relay = new HostInferenceRelay()
    const controller = new AbortController()
    const call = collect(relay.provider('m'), controller.signal)
    controller.abort(new Error('Stopped'))
    await assert.rejects(call, /Stopped/)
  })

  it('fails a call whose app stopped answering without closing the line', async () => {
    const relay = new HostInferenceRelay({ quietLimitMs: 20 })
    const { toApp } = await joined(relay, async function* (_request, signal) {
      yield { type: 'text', text: 'partial' }
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })
    })
    await assert.rejects(collect(relay.provider('m')), /stopped answering/)
    assert.ok(toApp.some((message) => message.t === 'infer-cancel'))
  })

  it('fails at once a call too big for the line, sending nothing', async () => {
    const relay = new HostInferenceRelay()
    const { toApp } = await joined(relay, async function* () {
      await Promise.resolve()
      yield { type: 'text', text: 'never' }
    })
    const tools = Array.from({ length: 2_001 }, (_, index) => ({
      name: `t${String(index)}`,
      description: '',
      parameters: {},
    }))
    const call = (async (): Promise<void> => {
      for await (const _chunk of relay.provider('m').stream([], tools)) {
        // never reached
      }
    })()
    await assert.rejects(call, /cannot be sent to the app/)
    assert.equal(toApp.length, 0)
  })

  it('ignores a reply from an app the call did not go to', async () => {
    const relay = new HostInferenceRelay({ createId: (): string => 'call-1', quietLimitMs: 50 })
    const other: TurnHostClient = {
      join: (): undefined => undefined,
      send: (): undefined => undefined,
    }
    await joined(relay, async function* (_request, signal) {
      relay.receive(
        { t: 'infer-chunk', id: 'call-1', chunk: { type: 'text', text: 'forged' } },
        other,
      )
      relay.receive({ t: 'infer-end', id: 'call-1' }, other)
      yield { type: 'text', text: 'real' }
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })
    })
    const chunks: ProviderStreamChunk[] = []
    await assert.rejects(async (): Promise<void> => {
      for await (const chunk of relay.provider('m').stream([], [])) chunks.push(chunk)
    }, /stopped answering/)
    assert.deepEqual(chunks, [{ type: 'text', text: 'real' }])
  })

  it('an app spends nothing for a worker of another version', async () => {
    const relay = new HostInferenceRelay()
    let asked = 0
    await joined(
      relay,
      async function* () {
        asked++
        await Promise.resolve()
        yield { type: 'text', text: 'paid' }
      },
      '0.9.0',
    )
    await assert.rejects(collect(relay.provider('m')), /only for a worker of its own version/)
    assert.equal(asked, 0)
  })

  it('holds calls past the limit until one ends, instead of failing them', async () => {
    const relay = new HostInferenceRelay()
    let started = 0
    let open = 0
    let most = 0
    let onStart: (() => void) | null = null
    const gates: (() => void)[] = []
    const startedAtLeast = async (count: number): Promise<void> => {
      while (started < count)
        await new Promise<void>((resolve) => {
          onStart = resolve
        })
    }
    await joined(relay, async function* () {
      started++
      open++
      most = Math.max(most, open)
      const gate = Promise.withResolvers<undefined>()
      gates.push(() => {
        gate.resolve(undefined)
      })
      onStart?.()
      await gate.promise
      open--
      yield { type: 'text', text: 'done' }
    })
    const total = MAX_OPEN_INFERENCES + 2
    const calls = Array.from({ length: total }, () => collect(relay.provider('m')))
    await startedAtLeast(MAX_OPEN_INFERENCES)
    for (let next = 0; next < total; next++) {
      gates[next]?.()
      await startedAtLeast(Math.min(total, MAX_OPEN_INFERENCES + next + 1))
    }
    const results = await Promise.all(calls)
    assert.ok(results.every((chunks) => chunks.length === 1))
    assert.equal(most, MAX_OPEN_INFERENCES)
  })

  it('keeps a quiet call the app says is still alive', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const relay = new HostInferenceRelay({ createId: (): string => 'call-1', quietLimitMs: 40 })
      const started = Promise.withResolvers<undefined>()
      const answer = Promise.withResolvers<undefined>()
      const { app } = await joined(relay, async function* () {
        started.resolve(undefined)
        await answer.promise
        yield { type: 'text', text: 'slow' }
      })
      const call = collect(relay.provider('m'))
      await started.promise
      for (let beat = 0; beat < 5; beat++) {
        mock.timers.tick(30)
        relay.receive({ t: 'infer-alive', id: 'call-1' }, app)
      }
      answer.resolve(undefined)
      assert.deepEqual(await call, [{ type: 'text', text: 'slow' }])
    } finally {
      mock.timers.reset()
    }
  })
})
