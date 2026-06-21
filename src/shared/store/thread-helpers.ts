// Use the Web Crypto API available in both browsers and Node 19+
const randomUUID = () => globalThis.crypto.randomUUID()
import type { AppStore } from './store.ts'
import type {
  Message,
  ToolCall,
  ThreadUsage,
  UsageDelta,
  ContextTrimRecord,
  ContextSnapshot,
} from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'

export function createThread(store: AppStore): string {
  const id = randomUUID()
  const threads = [
    ...store.getState().threads,
    {
      id,
      title: 'New Thread',
      status: 'idle' as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]
  store.setState({ threads, activeThreadId: id })
  store.emit('threads_changed')
  return id
}

export function switchThread(store: AppStore, id: string): void {
  store.setState({ activeThreadId: id })
  store.emit('threads_changed')
}

export function deleteThread(store: AppStore, id: string): void {
  const { threads, activeThreadId } = store.getState()
  const remaining = threads.filter((t) => t.id !== id)
  if (remaining.length === 0) {
    // Always keep at least one thread
    const newId = createThread(store)
    store.setState({
      threads: store.getState().threads.filter((t) => t.id !== newId || remaining.length > 0),
    })
    return
  }
  const newActive =
    activeThreadId === id ? (remaining[remaining.length - 1]?.id ?? null) : activeThreadId
  store.setState({ threads: remaining, activeThreadId: newActive })
  store.emit('threads_changed')
}

export function recordContextTrim(
  store: AppStore,
  threadId: string,
  record: Omit<ContextTrimRecord, 'at'>,
): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const entry: ContextTrimRecord = { ...record, at: Date.now() }
    return {
      ...t,
      contextTrims: [...(t.contextTrims ?? []), entry],
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads })
  store.emit('threads_changed')
}

export function addMessage(
  store: AppStore,
  threadId: string,
  role: Message['role'],
  content = '',
  images?: string[],
): string {
  const id = randomUUID()
  const { threads } = store.getState()
  const updated = threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          messages: [
            ...t.messages,
            {
              id,
              role,
              content,
              ...(images?.length ? { images } : {}),
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads: updated })
  store.emit('message_added', threadId, id)
  return id
}

export function appendToken(store: AppStore, messageId: string, text: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, content: m.content + text })),
  }))
  store.setState({ threads: updated })
  store.emit('message_token', messageId, text)
}

export function setMessageContent(store: AppStore, messageId: string, content: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, content })),
  }))
  store.setState({ threads: updated })
  store.emit('message_token', messageId, content)
}

export function addToolCall(store: AppStore, messageId: string, toolCall: ToolCall): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            toolCalls: [...m.toolCalls, toolCall],
          },
    ),
  }))
  store.setState({ threads: updated })
  store.emit('tool_call_started', messageId, toolCall)
}

export function updateToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  patch: Partial<ToolCall>,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            toolCalls: m.toolCalls.map((tc) => (tc.id !== toolCallId ? tc : { ...tc, ...patch })),
          },
    ),
  }))
  store.setState({ threads: updated })
  store.emit('tool_call_updated', messageId, toolCallId)
}

export function updateUsage(store: AppStore, threadId: string, usage: ThreadUsage): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, usage }))
  store.setState({ threads: updated })
  store.emit('usage_updated', threadId)
}

export function addUsageDelta(store: AppStore, threadId: string, delta: UsageDelta): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  const byModel = { ...(thread.usage.byModel ?? {}) }
  const prev = byModel[delta.model] ?? { inputTokens: 0, outputTokens: 0 }
  byModel[delta.model] = {
    inputTokens: prev.inputTokens + delta.inputTokens,
    outputTokens: prev.outputTokens + delta.outputTokens,
  }
  updateUsage(store, threadId, {
    inputTokens: thread.usage.inputTokens + delta.inputTokens,
    outputTokens: thread.usage.outputTokens + delta.outputTokens,
    byModel,
  })
}

export function updateContextSnapshot(
  store: AppStore,
  threadId: string,
  snapshot: Omit<ContextSnapshot, 'updatedAt'>,
): void {
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          contextSnapshot: { ...snapshot, updatedAt: Date.now() },
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  store.emit('context_updated', threadId)
}

export function clearContextSnapshot(store: AppStore, threadId: string): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { contextSnapshot: _removed, ...rest } = t
    return rest
  })
  store.setState({ threads })
  store.emit('context_updated', threadId)
}

export function setThreadTodos(store: AppStore, threadId: string, todos: TodoItem[]): void {
  const threads = store
    .getState()
    .threads.map((t) => (t.id !== threadId ? t : { ...t, todos, updatedAt: Date.now() }))
  store.setState({ threads })
  store.emit('todos_changed', threadId)
}

export function setThreadStatus(
  store: AppStore,
  threadId: string,
  status: 'idle' | 'running' | 'error',
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, status }))
  store.setState({ threads: updated })
  store.emit('thread_status_changed', threadId, status)
}

export function setThreadTitle(store: AppStore, threadId: string, title: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, title }))
  store.setState({ threads: updated })
  store.emit('threads_changed')
}

export function setThreadWorkingBrief(
  store: AppStore,
  threadId: string,
  workingBrief: string,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) =>
    t.id !== threadId ? t : { ...t, workingBrief, updatedAt: Date.now() },
  )
  store.setState({ threads: updated })
  store.emit('threads_changed')
}
