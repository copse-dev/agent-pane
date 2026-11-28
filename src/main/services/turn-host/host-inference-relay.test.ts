import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { HostInferenceRelay } from './host-inference-relay.ts'
import { TurnHostLink } from './turn-host-link.ts'
import type {
  AppToHost,
  HostInferRequest,
  HostToApp,
  TurnHostClient,
  TurnHostConnection,
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
              onMessage({ t: 'hello', version: VERSION, protocol: 3, pid: 1 })
            })
          else if (message.t === 'attach') relay.attach(app)
          else if (
            message.t === 'infer-chunk' ||
            message.t === 'infer-end' ||
            message.t === 'infer-error'
          )
            relay.receive(message)
        },
        close: (): void => undefined,
      })
    },
    readRecord: (): Promise<null> => Promise.resolve(null),
    isAlive: (): boolean => true,
    settleUncertain: (): Promise<void> => Promise.resolve(),
    infer,
  })
  assert.equal(await link.ensureConnected(), true)
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
})
