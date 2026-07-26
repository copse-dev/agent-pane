// Subagent helpers — mutate ToolCall.subagent on parent tool calls.
import type { AppStore } from './store.ts'
import { at } from '@shared/array-utils.ts'
import type { ModelUsage, SubagentSession, ToolCall } from '@shared/types'

/**
 * Replace exactly one tool call on one message, cloning only the owning thread,
 * its `messages` array, and that message's `toolCalls` array. Every unrelated
 * thread — and every sibling message and sibling tool call — keeps its object
 * identity, so a subagent stream's per-chunk work is proportional to the owning
 * thread's size rather than to all loaded history (issue #1155, subagent path).
 * Bumps the owning thread's `updatedAt` and emits `tool_call_updated`, matching
 * the prior behavior; a no-op (no `setState`/emit) when the tool call is absent.
 */
function replaceToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  update: (toolCall: ToolCall) => ToolCall,
): void {
  const { threads } = store.getState()
  for (let ti = 0; ti < threads.length; ti++) {
    const thread = threads[ti]
    if (!thread) continue
    const mi = thread.messages.findIndex((m) => m.id === messageId)
    if (mi === -1) continue
    const message = at(thread.messages, mi)
    const ci = message.toolCalls.findIndex((tc) => tc.id === toolCallId)
    if (ci === -1) return
    const toolCalls = message.toolCalls.slice()
    toolCalls[ci] = update(at(message.toolCalls, ci))
    const messages = thread.messages.slice()
    messages[mi] = { ...message, toolCalls }
    const nextThreads = threads.slice()
    nextThreads[ti] = { ...thread, messages, updatedAt: Date.now() }
    store.setState({ threads: nextThreads })
    store.emit('tool_call_updated', messageId, toolCallId)
    return
  }
}

function updateSubagentOnToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  updater: (session: SubagentSession) => SubagentSession,
): void {
  replaceToolCall(store, messageId, toolCallId, (tc) =>
    tc.subagent ? { ...tc, subagent: updater(tc.subagent) } : tc,
  )
}

export function initSubagent(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  session: SubagentSession,
): void {
  replaceToolCall(store, messageId, toolCallId, (tc) => ({ ...tc, subagent: session }))
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
