// Subagent helpers — mutate ToolCall.subagent on parent tool calls.
import type { AppStore } from './store.ts'
import type { ModelUsage, SubagentSession, ToolCall } from '@shared/types'

function findToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
): { msgIdx: number; tcIdx: number } | null {
  const { threads } = store.getState()
  for (const t of threads) {
    const msgIdx = t.messages.findIndex((m) => m.id === messageId)
    if (msgIdx < 0) continue
    const tcIdx = t.messages[msgIdx]!.toolCalls.findIndex((tc) => tc.id === toolCallId)
    if (tcIdx >= 0) return { msgIdx: threads.indexOf(t), tcIdx }
  }
  return null
}

function updateSubagentOnToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  updater: (session: SubagentSession) => SubagentSession,
): void {
  const loc = findToolCall(store, messageId, toolCallId)
  if (!loc) return
  const { threads } = store.getState()
  const updatedThreads = threads.map((t, ti) => {
    if (ti !== loc.msgIdx) return t
    return {
      ...t,
      messages: t.messages.map((m) => {
        if (m.id !== messageId) return m
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) => {
            if (tc.id !== toolCallId || !tc.subagent) return tc
            return { ...tc, subagent: updater(tc.subagent) }
          }),
        }
      }),
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads: updatedThreads })
  store.emit('tool_call_updated', messageId, toolCallId)
}

export function initSubagent(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  session: SubagentSession,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id !== toolCallId ? tc : { ...tc, subagent: session },
            ),
          },
    ),
    updatedAt: Date.now(),
  }))
  store.setState({ threads: updated })
  store.emit('tool_call_updated', messageId, toolCallId)
}

export function appendSubagentText(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  subMessageId: string,
  text: string,
): void {
  updateSubagentOnToolCall(store, messageId, toolCallId, (session) => {
    const existing = session.messages.find((m) => m.id === subMessageId)
    if (existing) {
      return {
        ...session,
        messages: session.messages.map((m) =>
          m.id !== subMessageId ? m : { ...m, content: m.content + text },
        ),
      }
    }
    return {
      ...session,
      messages: [
        ...session.messages,
        {
          id: subMessageId,
          role: 'assistant',
          content: text,
          toolCalls: [],
          createdAt: Date.now(),
        },
      ],
    }
  })
}

export function addSubagentToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  subMessageId: string,
  toolCall: ToolCall,
): void {
  updateSubagentOnToolCall(store, messageId, toolCallId, (session) => {
    const existing = session.messages.find((m) => m.id === subMessageId)
    if (existing) {
      return {
        ...session,
        messages: session.messages.map((m) =>
          m.id !== subMessageId ? m : { ...m, toolCalls: [...m.toolCalls, toolCall] },
        ),
      }
    }
    return {
      ...session,
      messages: [
        ...session.messages,
        {
          id: subMessageId,
          role: 'assistant',
          content: '',
          toolCalls: [toolCall],
          createdAt: Date.now(),
        },
      ],
    }
  })
}

export function updateSubagentToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  innerToolCallId: string,
  patch: Partial<ToolCall>,
): void {
  updateSubagentOnToolCall(store, messageId, toolCallId, (session) => ({
    ...session,
    messages: session.messages.map((m) => ({
      ...m,
      toolCalls: m.toolCalls.map((tc) => (tc.id !== innerToolCallId ? tc : { ...tc, ...patch })),
    })),
  }))
}

export function finishSubagent(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  summary: string,
  status: SubagentSession['status'],
  usage?: ModelUsage,
): void {
  updateSubagentOnToolCall(store, messageId, toolCallId, (session) => ({
    ...session,
    status,
    summary,
    ...(usage ? { usage } : {}),
  }))
}
