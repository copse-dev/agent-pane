import { randomUUID } from 'node:crypto'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import type { BuildProviderOptions } from '../providers/provider-selection.ts'
import type { HostToApp, TurnHostClient } from './turn-host-protocol.ts'

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
 * reply fails that call, as a dropped connection to a provider would.
 */

interface OpenCall {
  client: TurnHostClient
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
  private appWaiters: (() => void)[] = []
  private readonly createId: () => string

  constructor(createId: () => string = randomUUID) {
    this.createId = createId
  }

  attach(client: TurnHostClient): void {
    if (!this.apps.includes(client)) this.apps.push(client)
    for (const wake of this.appWaiters.splice(0)) wake()
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

  /** The app's reply to a call. */
  receive(
    message:
      | { t: 'infer-chunk'; id: string; chunk: ProviderStreamChunk }
      | { t: 'infer-end'; id: string }
      | { t: 'infer-error'; id: string; error: string },
  ): void {
    const call = this.calls.get(message.id)
    if (call === undefined) return
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

  private async waitForApp(signal: AbortSignal | undefined): Promise<TurnHostClient> {
    for (;;) {
      signal?.throwIfAborted()
      const app = this.apps.at(-1)
      if (app !== undefined) return app
      const { promise, resolve, reject } = Promise.withResolvers<undefined>()
      const abort = (): void => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.appWaiters.push(() => {
        resolve(undefined)
      })
      try {
        await promise
      } finally {
        signal?.removeEventListener('abort', abort)
      }
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
    const client = await this.waitForApp(signal)
    const id = this.createId()
    const queue: ProviderStreamChunk[] = []
    // Set from callbacks; an object so the loop below reads it fresh.
    const state: { finished: { error?: Error | undefined } | null } = { finished: null }
    let wake: (() => void) | null = null
    const notify = (): void => {
      wake?.()
      wake = null
    }
    this.calls.set(id, {
      client,
      push: (chunk) => {
        queue.push(chunk)
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
    const request: Extract<HostToApp, { t: 'infer' }> = {
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
      client.send(request)
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
      signal?.removeEventListener('abort', cancel)
      // A caller that stopped reading early: the app can stop paying for it.
      if (this.calls.delete(id)) client.send({ t: 'infer-cancel', id })
    }
  }
}
