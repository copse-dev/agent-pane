import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { QueuedUserMessage } from '@shared/types'
import { clearContextSnapshot, setThreadStatus } from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'

function refreshPayload(
  store: AppStore,
  threadId: string,
  payload: AgentRunPayload,
): AgentRunPayload {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  return {
    ...payload,
    priorTodos: thread?.todos ?? payload.priorTodos ?? [],
    ...(thread?.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
  }
}

export function dispatchAgentRun(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  payload: AgentRunPayload,
): void {
  clearContextSnapshot(store, threadId)
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.run(threadId, JSON.stringify(refreshPayload(store, threadId, payload)))
}

export function enqueueUserMessage(
  store: AppStore,
  threadId: string,
  item: QueuedUserMessage,
): void {
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          pendingMessages: [...(t.pendingMessages ?? []), item],
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  store.emit('message_queued', threadId, item.messageId)
  store.emit('threads_changed')
}

export function drainMessageQueue(store: AppStore, api: ApiClient, threadId: string): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread || thread.status !== 'idle') return
  const pending = thread.pendingMessages ?? []
  if (pending.length === 0) return

  const [next, ...rest] = pending
  if (!next) return
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...restThread } = t
    return rest.length > 0
      ? { ...restThread, pendingMessages: rest, updatedAt: Date.now() }
      : { ...restThread, updatedAt: Date.now() }
  })
  store.setState({ threads })
  store.emit('threads_changed')
  dispatchAgentRun(store, api, threadId, next.payload)
}

export function resumePendingQueues(store: AppStore, api: ApiClient): void {
  for (const thread of store.getState().threads) {
    if (thread.status === 'idle' && (thread.pendingMessages?.length ?? 0) > 0) {
      drainMessageQueue(store, api, thread.id)
    }
  }
}

export function queuedMessageIds(thread: { pendingMessages?: QueuedUserMessage[] }): Set<string> {
  return new Set((thread.pendingMessages ?? []).map((item) => item.messageId))
}
