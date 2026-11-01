import { z } from 'zod'
import { RemoteRequestError } from './transport.ts'
import {
  remoteStateSchema,
  remoteThreadSchema,
  type RemoteRead,
  type RemoteState,
  type RemoteView,
} from '../../shared/remote-interface.ts'

type Transport = (path: string, options?: RequestInit) => Promise<unknown>
type Action = { projectId: string; threadId: string } & (
  | { action: 'message'; text: string }
  | { action: 'stop'; runId: string }
)
const actionResultSchema = z.object({ ok: z.boolean().optional(), error: z.string().optional() })

/** Retire known rejections; uncertain deliveries keep their identity until confirmed. */
export class RemoteActions {
  private pending = new Map<string, { requestId: string; sessionId: string; issuedAt: number }>()
  private expired = new Set<string>()
  private transport: Transport
  private confirmRetry: () => boolean | Promise<boolean>

  constructor(transport: Transport, confirmRetry: () => boolean | Promise<boolean>) {
    this.transport = transport
    this.confirmRetry = confirmRetry
  }

  async run(payload: Action, sessionId: string): Promise<void> {
    const key = JSON.stringify(payload)
    let envelope = this.pending.get(key)
    if (
      envelope &&
      (envelope.sessionId !== sessionId ||
        Date.now() - envelope.issuedAt > 120_000 ||
        this.expired.has(key))
    ) {
      if (!(await this.confirmRetry()))
        throw new Error(
          'Delivery is uncertain. Check the chat before sending again. Your draft is kept.',
        )
      this.pending.delete(key)
      this.expired.delete(key)
      envelope = undefined
    }
    if (!envelope) {
      envelope = { requestId: crypto.randomUUID(), sessionId, issuedAt: Date.now() }
      this.pending.set(key, envelope)
    }
    try {
      const result = actionResultSchema.parse(
        await this.transport('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...envelope, ...payload }),
        }),
      )
      if (result.error) throw new RemoteRequestError(409, result.error)
      this.pending.delete(key)
      this.expired.delete(key)
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status >= 400 && error.status < 500) {
        if (error.message.includes('expired')) this.expired.add(key)
        else this.pending.delete(key)
      }
      throw error
    }
  }
}

export type RemoteThread = RemoteView['threads'][number]

/** Browser replicas never dispatch the agent or persist the desktop transcript. */
export class RemoteChatClient {
  private hints = new Map<string, Promise<string | null>>()
  private session: string | null = null
  private latest: RemoteState | null = null
  private transcripts = new Map<string, RemoteThread>()

  private transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  async snapshot(): Promise<RemoteState> {
    const state = remoteStateSchema.parse(await this.transport('/api/remote/state'))
    if (this.session !== state.sessionId) {
      this.session = state.sessionId
      this.hints.clear()
      this.transcripts.clear()
    }
    if (this.latest?.sessionId === state.sessionId && this.latest.revision === state.revision)
      return this.latest
    this.latest = state
    return state
  }

  async thread(projectId: string, threadId: string): Promise<RemoteThread | null> {
    const state = await this.snapshot()
    const thread =
      state.views
        .find((view) => view.projectId === projectId)
        ?.threads.find((thread) => thread.id === threadId) ?? null
    return thread?.messagesLoaded === false ? null : thread
  }

  /** A metadata-only desktop snapshot must never replace the browser's loaded history. */
  async hydrate(projectId: string, thread: RemoteThread): Promise<RemoteThread> {
    const key = JSON.stringify([projectId, thread.id])
    if (thread.messagesLoaded !== false) {
      this.transcripts.set(key, thread)
      return thread
    }
    const cached = this.transcripts.get(key)
    const saved =
      cached?.updatedAt === thread.updatedAt
        ? cached
        : remoteThreadSchema.parse({
            ...thread,
            messages: await this.read('threads:load-messages', [projectId, thread.id]),
            messagesLoaded: true,
          })
    const messages = new Map(saved.messages.map((message) => [message.id, message]))
    for (const message of thread.messages) messages.set(message.id, message)
    const hydrated = { ...thread, messages: [...messages.values()], messagesLoaded: true }
    this.transcripts.set(key, hydrated)
    return hydrated
  }

  private async read(channel: RemoteRead['channel'], args: unknown[]): Promise<unknown> {
    const response = await this.transport('/api/remote/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, channel, args }),
    })
    return z.object({ value: z.unknown() }).parse(response).value
  }

  async hint(thread: RemoteThread): Promise<string | null> {
    if (thread.status !== 'idle') return null
    const user = thread.messages.filter((message) => message.role === 'user').at(-1)
    const assistant = thread.messages.filter((message) => message.role === 'assistant').at(-1)
    if (!user?.content.trim() || !assistant?.content.trim()) return null
    // A user prompt after the last assistant is queued, not a completed exchange.
    if (thread.messages.indexOf(user) > thread.messages.indexOf(assistant)) return null
    const key = JSON.stringify([thread.id, user.id, assistant.id])
    let pending = this.hints.get(key)
    if (!pending) {
      pending = (async (): Promise<string | null> => {
        if ((await this.read('settings:get', ['nextStepSuggestionEnabled'])) === false) return null
        const value = await this.read('agent:suggest-next-step', [
          JSON.stringify({
            userMessage: user.content,
            assistantMessage: assistant.content,
            toolNames: assistant.toolCalls.map((tool) => tool.name),
          }),
        ])
        return z.string().max(2000).nullable().parse(value)
      })().catch(() => null)
      this.hints.set(key, pending)
      if (this.hints.size > 100) {
        const oldest = this.hints.keys().next().value
        if (oldest !== undefined) this.hints.delete(oldest)
      }
    }
    return pending
  }

  spend(threadId: string): void {
    for (const key of this.hints.keys()) {
      if (key.startsWith(JSON.stringify([threadId]).slice(0, -1) + ',')) {
        this.hints.set(key, Promise.resolve(null))
      }
    }
  }
}
