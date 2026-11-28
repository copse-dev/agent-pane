import { randomUUID } from 'node:crypto'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import type { BuildProviderOptions } from '../providers/provider-selection.ts'
import { MAX_LINE_CHARS } from '../local-socket.ts'
import {
  hostInferRequestSchema,
  MAX_OPEN_INFERENCES,
  type HostInferRequest,
  type TurnHostClient,
} from './turn-host-protocol.ts'

/**
 * A worker's model calls, made by the app that attached to it
 * (`docs/plans/harness-worker-roadmap.md`, R3 step 2).
 *
 * A worker on another machine holds no model keys: they stay on the laptop
 * unless the user leases one to it. So each call goes over the line as
 * `infer`, the app builds the provider for that model with its own keys and
 * streams the reply back as `infer-chunk`, then `infer-end` or `infer-error`.
 * A Stop sends `infer-cancel`.
 *
 * One app makes each call, the one that attached last, so no call is paid for
 * twice. With no app attached a call waits for one: a turn pauses while the
 * laptop sleeps and carries on when it wakes. An app that goes away during a
 * reply fails that call, as a dropped connection to a provider would, and so
 * does a reply that goes quiet for {@link QUIET_LIMIT_MS} (the app says
 * `infer-alive` each minute while it works): a line that stalled without
 * closing must not hold a turn for ever. At most {@link MAX_OPEN_INFERENCES}
 * calls are open at once; later ones wait for one to end.
 */

/** How long a reply may go without a chunk before its call fails. */
export const QUIET_LIMIT_MS = 10 * 60_000

interface OpenCall {
  client: TurnHostClient
  alive: () => void
  push: (chunk: ProviderStreamChunk) => void
  end: (error?: Error) => void
}

/** The options a call carries over the line: plain values only. */
type RelayedStreamOptions = Pick<
  LLMStreamOptions,
  'toolChoice' | 'compactAtTokens' | 'suppressReasoning'
>

function relayedOptions(options: LLMStreamOptions | undefined): RelayedStreamOptions | undefined {
  if (options === undefined) return undefined
  const { toolChoice, compactAtTokens, suppressReasoning } = options
  return {
    ...(toolChoice === undefined ? {} : { toolChoice: { name: toolChoice.name } }),
    ...(compactAtTokens === undefined ? {} : { compactAtTokens }),
    ...(suppressReasoning === undefined ? {} : { suppressReasoning }),
  }
}

export class HostInferenceRelay {
  /** Attached apps, latest last. */
  private readonly apps: TurnHostClient[] = []
  private readonly calls = new Map<string, OpenCall>()
  private readonly appWaiters = new Set<() => void>()
  /** Calls holding a slot, and the calls waiting for one. */
  private open = 0
  private readonly slotWaiters = new Set<() => void>()
  private readonly createId: () => string
  private readonly quietLimitMs: number

  constructor(options: { createId?: () => string; quietLimitMs?: number } = {}) {
    this.createId = options.createId ?? randomUUID
    this.quietLimitMs = options.quietLimitMs ?? QUIET_LIMIT_MS
  }

  attach(client: TurnHostClient): void {
    if (!this.apps.includes(client)) this.apps.push(client)
    const waiters = [...this.appWaiters]
    this.appWaiters.clear()
    for (const wake of waiters) wake()
  }

  /** An app's line closed: its calls fail, and later ones go to another app. */
  left(client: TurnHostClient): void {
    const index = this.apps.indexOf(client)
    if (index !== -1) this.apps.splice(index, 1)
    for (const [id, call] of this.calls)
      if (call.client === client) {
        this.calls.delete(id)
        call.end(new Error('The app making this model call went away; try again.'))
      }
  }

  /** The app's reply to a call; only the app the call went to may answer it. */
  receive(
    message:
      | { t: 'infer-chunk'; id: string; chunk: ProviderStreamChunk }
      | { t: 'infer-end'; id: string }
      | { t: 'infer-error'; id: string; error: string }
      | { t: 'infer-alive'; id: string },
    from: TurnHostClient,
  ): void {
    const call = this.calls.get(message.id)
    if (call === undefined || call.client !== from) return
    if (message.t === 'infer-alive') {
      call.alive()
      return
    }
    if (message.t === 'infer-chunk') {
      call.push(message.chunk)
      return
    }
    this.calls.delete(message.id)
    call.end(message.t === 'infer-error' ? new Error(message.error) : undefined)
  }

  /** A provider for `model` whose calls the attached app makes. */
  provider(model: string, promptCacheKey?: string, opts: BuildProviderOptions = {}): LLMProvider {
    return {
      stream: (messages, tools, signal, options) =>
        this.stream({ model, promptCacheKey, opts, messages, tools, options }, signal),
    }
  }

  /** Resolve once `ready` gives a value, or reject when `signal` aborts. */
  private async waitFor<T>(
    ready: () => T | undefined,
    waiters: Set<() => void>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted()
      const value = ready()
      if (value !== undefined) return value
      const { promise, resolve, reject } = Promise.withResolvers<undefined>()
      const wake = (): void => {
        resolve(undefined)
      }
      const abort = (): void => {
        // Gone at once, not in the finally a microtask later: a release in
        // between would otherwise spend its wake-up on this dead waiter.
        waiters.delete(wake)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      waiters.add(wake)
      try {
        await promise
      } finally {
        signal?.removeEventListener('abort', abort)
        waiters.delete(wake)
      }
    }
  }

  private takeSlot(): true | undefined {
    if (this.open >= MAX_OPEN_INFERENCES) return undefined
    this.open++
    return true
  }

  private release(): void {
    this.open--
    const [next] = this.slotWaiters
    if (next !== undefined) {
      this.slotWaiters.delete(next)
      next()
    }
  }

  private async *stream(
    call: {
      model: string
      promptCacheKey: string | undefined
      opts: BuildProviderOptions
      messages: LLMMessage[]
      tools: LLMTool[]
      options: LLMStreamOptions | undefined
    },
    signal: AbortSignal | undefined,
  ): AsyncIterable<ProviderStreamChunk> {
    // Taken where it is checked: a check and a later take would let every
    // caller waiting in the same tick through.
    await this.waitFor(() => this.takeSlot(), this.slotWaiters, signal)
    try {
      yield* this.relay(call, signal)
    } finally {
      this.release()
    }
  }

  private async *relay(
    call: {
      model: string
      promptCacheKey: string | undefined
      opts: BuildProviderOptions
      messages: LLMMessage[]
      tools: LLMTool[]
      options: LLMStreamOptions | undefined
    },
    signal: AbortSignal | undefined,
  ): AsyncIterable<ProviderStreamChunk> {
    const client = await this.waitFor(() => this.apps.at(-1), this.appWaiters, signal)
    const id = this.createId()
    if (this.calls.has(id)) throw new Error('A model call with this id is already open.')
    const queue: ProviderStreamChunk[] = []
    // Set from callbacks; an object so the loop below reads it fresh.
    const state: { finished: { error?: Error | undefined } | null } = { finished: null }
    let wake: (() => void) | null = null
    const notify = (): void => {
      wake?.()
      wake = null
    }
    let quiet: NodeJS.Timeout | undefined
    const heard = (): void => {
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        if (this.calls.delete(id)) client.send({ t: 'infer-cancel', id })
        state.finished ??= {
          error: new Error('The app making this model call stopped answering; try again.'),
        }
        notify()
      }, this.quietLimitMs)
      quiet.unref()
    }
    this.calls.set(id, {
      client,
      alive: heard,
      push: (chunk) => {
        queue.push(chunk)
        heard()
        notify()
      },
      end: (error) => {
        state.finished = { error }
        notify()
      },
    })
    const cancel = (): void => {
      if (this.calls.delete(id)) client.send({ t: 'infer-cancel', id })
      state.finished ??= {
        error: signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'),
      }
      notify()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    const { maxOutputTokens, reasoning, maxReasoning } = call.opts
    const options = relayedOptions(call.options)
    const request: HostInferRequest = {
      t: 'infer',
      id,
      model: call.model,
      ...(call.promptCacheKey === undefined ? {} : { promptCacheKey: call.promptCacheKey }),
      providerOptions: {
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(maxReasoning === undefined ? {} : { maxReasoning }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      },
      messages: call.messages,
      tools: call.tools,
      ...(options === undefined ? {} : { options }),
    }
    try {
      const checked = hostInferRequestSchema.safeParse(request)
      // A line the app would not read closes it, and every call on it.
      const problem = !checked.success
        ? (checked.error.issues[0]?.message ?? 'it is malformed')
        : JSON.stringify(request).length >= MAX_LINE_CHARS
          ? 'it is too large'
          : null
      if (problem !== null) {
        this.calls.delete(id)
        throw new Error(`This model call cannot be sent to the app: ${problem}`)
      }
      client.send(request)
      heard()
      for (;;) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        const done = state.finished
        if (done !== null) {
          if (done.error !== undefined) throw done.error
          return
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      clearTimeout(quiet)
      signal?.removeEventListener('abort', cancel)
      // A caller that stopped reading early: the app can stop paying for it.
      if (this.calls.delete(id)) client.send({ t: 'infer-cancel', id })
    }
  }
}
