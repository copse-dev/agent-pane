import { z } from 'zod'
import {
  remoteStateSchema,
  type RemoteRead,
  type RemoteView,
} from '../../shared/remote-interface.ts'

type Transport = (path: string, options?: RequestInit) => Promise<unknown>
export type RemoteThread = RemoteView['threads'][number]

/** Browser replicas never dispatch the agent or persist the desktop transcript. */
export class RemoteChatClient {
  private hints = new Map<string, Promise<string | null>>()
  private session: string | null = null

  private transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  async thread(projectId: string, threadId: string): Promise<RemoteThread | null> {
    const state = remoteStateSchema.parse(await this.transport('/api/remote/state'))
    if (this.session !== state.sessionId) {
      this.session = state.sessionId
      this.hints.clear()
    }
    return (
      state.views
        .find((view) => view.projectId === projectId)
        ?.threads.find((thread) => thread.id === threadId) ?? null
    )
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
