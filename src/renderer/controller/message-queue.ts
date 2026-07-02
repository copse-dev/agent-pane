import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { Message, QueuedUserMessage, UserContent } from '@shared/types'
import {
  clearContextSnapshot,
  setMessageContent,
  setQueuePaused,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'

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
  if (!thread || thread.status !== 'idle' || thread.queuePaused) return
  const pending = thread.pendingMessages ?? []
  if (pending.length === 0) return

  const [next, ...rest] = pending
  if (!next) return
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...restThread } = t
    const messages = movePendingUserMessagesToEnd(t.messages, pending)
    return rest.length > 0
      ? { ...restThread, messages, pendingMessages: rest, updatedAt: Date.now() }
      : { ...restThread, messages, updatedAt: Date.now() }
  })
  store.setState({ threads })
  store.emit('threads_changed')
  dispatchAgentRun(store, api, threadId, next.payload)
}

export function movePendingUserMessagesToEnd(
  messages: Message[],
  pending: QueuedUserMessage[],
): Message[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  const pendingMessages: Message[] = []
  const movedIds = new Set<string>()
  for (const item of pending) {
    const message = messagesById.get(item.messageId)
    if (!message || message.role !== 'user' || movedIds.has(message.id)) continue
    pendingMessages.push(message)
    movedIds.add(message.id)
  }
  if (pendingMessages.length === 0) return messages

  const settledMessages = messages.filter((message) => !movedIds.has(message.id))
  const nextMessages = [...settledMessages, ...pendingMessages]
  const alreadyInOrder = nextMessages.every((message, index) => message === messages[index])
  return alreadyInOrder ? messages : nextMessages
}

export function resumePendingQueues(store: AppStore, api: ApiClient): void {
  for (const thread of store.getState().threads) {
    // A fresh session has no open inline editors, so a persisted pause is stale.
    if (thread.queuePaused) setQueuePaused(store, thread.id, false)
    // A crash mid-run can leave status stuck at running with no live main-process run.
    let status = thread.status
    if (status === 'running') {
      setThreadStatus(store, thread.id, 'idle')
      status = 'idle'
    }
    if (status === 'idle' && (thread.pendingMessages?.length ?? 0) > 0) {
      drainMessageQueue(store, api, thread.id)
    }
  }
}

export function queuedMessageIds(thread: { pendingMessages?: QueuedUserMessage[] }): Set<string> {
  return new Set((thread.pendingMessages ?? []).map((item) => item.messageId))
}

/** The user-authored text portion of a queued payload (the editable bit). */
export function queuedPayloadText(payload: AgentRunPayload): string {
  const content = payload.content
  if (typeof content === 'string') return content
  return content.find((block) => block.type === 'text')?.text ?? ''
}

function withPayloadText(content: UserContent, text: string): UserContent {
  if (typeof content === 'string') return text
  let replaced = false
  const next = content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { ...block, text }
  })
  // `replaced` is mutated inside the .map callback above, which ESLint's
  // control-flow analysis cannot track, so it wrongly flags this as falsy.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return replaced ? next : [...next, { type: 'text' as const, text }]
}

/**
 * Persist an inline edit to a queued message: updates both the run payload (what
 * the agent receives) and the displayed bubble text.
 */
export function updateQueuedMessageText(
  store: AppStore,
  threadId: string,
  messageId: string,
  text: string,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const item = thread?.pendingMessages?.find((p) => p.messageId === messageId)
  if (!item) return
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          pendingMessages: (t.pendingMessages ?? []).map((p) =>
            p.messageId !== messageId
              ? p
              : {
                  ...p,
                  payload: { ...p.payload, content: withPayloadText(p.payload.content, text) },
                },
          ),
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  setMessageContent(store, messageId, text)
  store.emit('threads_changed')
}

/**
 * Run a queued message immediately: move it to the front of the queue, lift any
 * editing pause, then abort the active run. The trailing `done` chunk triggers
 * the normal FIFO drain, which now dispatches this message first.
 */
/** Drop a queued follow-up from the FIFO list and remove its user bubble. */
export function removeQueuedMessage(store: AppStore, threadId: string, messageId: string): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  const pending = thread.pendingMessages ?? []
  if (!pending.some((p) => p.messageId === messageId)) return

  const remainingPending = pending.filter((p) => p.messageId !== messageId)
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...rest } = t
    return {
      ...rest,
      messages: t.messages.filter((m) => m.id !== messageId),
      ...(remainingPending.length > 0 ? { pendingMessages: remainingPending } : {}),
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads })
  store.emit('threads_changed')
}

export function sendQueuedMessageNow(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  messageId: string,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const pending = thread?.pendingMessages ?? []
  const target = pending.find((p) => p.messageId === messageId)
  if (!thread || !target) return

  const reordered = [target, ...pending.filter((p) => p.messageId !== messageId)]
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { queuePaused: _removed, ...rest } = t
    return { ...rest, pendingMessages: reordered, updatedAt: Date.now() }
  })
  store.setState({ threads })
  store.emit('threads_changed')

  if (thread.status === 'running') {
    // Remote agents run on the provider's servers, where aborting cancels the live
    // run ("Agent already has an active run" on the next turn). Leave the reordered
    // message queued — it drains onto the same remote agent once this run finishes,
    // so a follow-up never kills the agent. Local runs interrupt as before.
    const model = store.getState().settings?.model ?? ''
    if (isRemoteAgentModel(model)) return
    // Abort the live run; its `done` chunk drains the reordered queue head.
    void api.agent.abort(threadId)
  } else {
    drainMessageQueue(store, api, threadId)
  }
}
