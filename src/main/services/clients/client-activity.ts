import { z } from 'zod'
import type { Thread, Message } from '@shared/types'
import type {
  ClientActivityData,
  ClientThreadText,
} from '../../../shared/plugin-client-protocol.ts'
import { listRunningThreadIds } from '../agent-service.ts'
import { humanDecisions } from '../human-decisions.ts'
import { storageGet } from '../storage/storage.ts'
import { loadProjectThreadMetas, loadThreadMessages } from '../thread-store.ts'

const projectsSchema = z.array(
  z.object({ id: z.string().regex(/^[\w-]{1,128}$/), name: z.string() }),
)
type ActivityMeta = Pick<
  Thread,
  | 'id'
  | 'title'
  | 'status'
  | 'usage'
  | 'updatedAt'
  | 'lastSettledAt'
  | 'lastPromptAt'
  | 'archivedAt'
  | 'sideChat'
  | 'interruptedTurnAt'
>
const scopeKey = (projectId: string, threadId: string): string =>
  JSON.stringify([projectId, threadId])
const displayText = (text: string): string => text.replace(/[\r\n\t]/g, ' ').slice(0, 200)

/** Shared projection over metadata: reading activity never hydrates a transcript or checkout. */
export function projectClientActivity(
  projects: ReadonlyArray<{ id: string; name: string; threads: readonly ActivityMeta[] }>,
  running: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
): ClientActivityData {
  const result: ClientActivityData = { recentThreads: [], runningCount: 0, waitingCount: 0 }
  for (const project of projects) {
    if (!/^[\w-]{1,128}$/.test(project.id)) continue
    for (const thread of project.threads) {
      if (thread.archivedAt !== undefined || thread.sideChat !== undefined) continue
      if (!/^[\w-]{1,128}$/.test(thread.id)) continue
      if (waiting.has(scopeKey(project.id, thread.id))) {
        result.waitingCount++
        continue
      }
      if (running.has(thread.id) || thread.status === 'running') {
        result.runningCount++
        continue
      }
      if (thread.lastPromptAt === undefined && thread.usage.outputTokens === 0) continue
      // Older metadata has no explicit completion timestamp. Only used chats
      // qualify for its updatedAt fallback; a new empty chat is not finished work.
      const settledAt =
        thread.lastSettledAt ??
        (thread.lastPromptAt !== undefined || thread.usage.outputTokens > 0
          ? thread.updatedAt
          : undefined)
      if (
        settledAt === undefined ||
        !Number.isSafeInteger(settledAt) ||
        settledAt < 0 ||
        thread.interruptedTurnAt !== undefined
      )
        continue
      result.recentThreads.push({
        projectId: project.id,
        projectName: displayText(project.name),
        threadId: thread.id,
        title: displayText(thread.title || 'Untitled chat'),
        state: thread.status === 'error' ? 'failed' : 'finished',
        settledAt,
      })
      result.recentThreads.sort(
        (a, b) =>
          b.settledAt - a.settledAt ||
          a.projectId.localeCompare(b.projectId) ||
          a.threadId.localeCompare(b.threadId),
      )
      if (result.recentThreads.length > 20) result.recentThreads.pop()
    }
  }
  return result
}

/** Coalesce concurrent clients and bound ordinary polling to one metadata read per two seconds. */
export class ClientActivityReader {
  private cached: ClientActivityData | undefined
  private readAt = -Infinity
  private pending: Promise<ClientActivityData> | undefined
  private readonly load: () => Promise<ClientActivityData>
  constructor(load: () => Promise<ClientActivityData>) {
    this.load = load
  }

  async read(fresh = false): Promise<ClientActivityData> {
    if (!fresh && this.cached && Date.now() - this.readAt < 2000)
      return structuredClone(this.cached)
    const earlier = this.pending
    if (fresh && earlier) {
      await earlier
      if (this.pending === earlier) this.pending = undefined
    }
    this.pending ??= this.load().then((value) => {
      this.cached = value
      this.readAt = Date.now()
      return value
    })
    const pending = this.pending
    try {
      return structuredClone(await pending)
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }
}

export const clientActivity = new ClientActivityReader(async () => {
  const projects = projectsSchema.safeParse(storageGet('projects'))
  if (!projects.success) return { recentThreads: [], runningCount: 0, waitingCount: 0 }
  const loaded: Array<{ id: string; name: string; threads: Thread[] }> = []
  for (const project of projects.data) {
    loaded.push({ ...project, threads: await loadProjectThreadMetas(project.id) })
  }
  return projectClientActivity(
    loaded,
    new Set(listRunningThreadIds()),
    new Set(humanDecisions.snapshot().requests.map((row) => scopeKey(row.projectId, row.threadId))),
  )
})

/** Only visible user/assistant text, never reasoning, tools, images or attachment data. */
export function projectClientThreadText(
  messages: readonly Pick<Message, 'role' | 'content'>[],
): ClientThreadText {
  const result: ClientThreadText = { messages: [], truncated: false }
  let remaining = 24000
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = message.content.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim()
    if (!text) continue
    if (result.messages.length === 8 || remaining === 0) {
      result.truncated = true
      break
    }
    // Preserve the start of an oversized message and explicitly report the omitted tail.
    result.messages.unshift({ role: message.role, text: text.slice(0, remaining) })
    if (text.length > remaining) result.truncated = true
    remaining -= Math.min(text.length, remaining)
  }
  return result
}

export async function readClientThreadText(
  projectId: string,
  threadId: string,
): Promise<ClientThreadText> {
  return projectClientThreadText(await loadThreadMessages(projectId, threadId))
}
