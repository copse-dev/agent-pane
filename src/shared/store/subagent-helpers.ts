// Subagent helpers — mutate ToolCall.subagent on parent tool calls.
import type { AppStore } from './store.ts'
import { locateMessage } from './thread-helpers.ts'
import type { ModelUsage, SubagentSession, ToolCall } from '@shared/types'

/**
 * Apply an in-place update to exactly one tool call, located in O(1) via the
 * shared message index. Mirrors thread-helpers' `updateMessage`: the store is
 * emit-reactive and persistence is value-based, so a subagent stream chunk can
 * mutate the tool call directly — no thread/`messages`/`toolCalls`-array copies,
 * every object keeps its identity, and per-chunk work is independent of
 * loaded-history size (issue #1255). Bumps the owning thread's `updatedAt` and
 * emits `tool_call_updated`, matching the prior behavior; a no-op (no emit) when
 * the message or tool call is absent.
 */
function replaceToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  update: (toolCall: ToolCall) => void,
): void {
  const loc = locateMessage(store, messageId)
  if (!loc) return
  const toolCall = loc.message.toolCalls.find((tc) => tc.id === toolCallId)
  if (!toolCall) return
  update(toolCall)
  loc.thread.updatedAt = Date.now()
  store.emit('tool_call_updated', messageId, toolCallId)
}

function updateSubagentOnToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  updater: (session: SubagentSession) => SubagentSession,
): void {
  replaceToolCall(store, messageId, toolCallId, (tc) => {
    if (tc.subagent) tc.subagent = updater(tc.subagent)
  })
}

export function initSubagent(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  session: SubagentSession,
): void {
  replaceToolCall(store, messageId, toolCallId, (tc) => {
    tc.subagent = session
  })
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

export function appendSubagentReasoning(
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
          m.id !== subMessageId ? m : { ...m, reasoning: (m.reasoning ?? '') + text },
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
          toolCalls: [],
          createdAt: Date.now(),
          reasoning: text,
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
