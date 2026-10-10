import type { SessionUpdate } from '@agentclientprotocol/sdk'

interface SessionActivity {
  lastUpdateAt: number
  pendingToolCalls: Set<string>
}

const activity = new WeakMap<object, SessionActivity>()

/** Track activity even between prompts and while cancelled output is suppressed. */
export function noteAcpSessionActivity(session: object, update: SessionUpdate): void {
  let state = activity.get(session)
  if (!state) {
    state = { lastUpdateAt: 0, pendingToolCalls: new Set() }
    activity.set(session, state)
  }
  state.lastUpdateAt = Date.now()
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
  if (update.status === 'completed' || update.status === 'failed') {
    state.pendingToolCalls.delete(update.toolCallId)
  } else if (update.sessionUpdate === 'tool_call' || update.status != null) {
    state.pendingToolCalls.add(update.toolCallId)
  }
}

export function acpSessionActivity(session: object): {
  lastUpdateAt: number
  hasPendingTools: boolean
} {
  const state = activity.get(session)
  return {
    lastUpdateAt: state?.lastUpdateAt ?? 0,
    hasPendingTools: (state?.pendingToolCalls.size ?? 0) > 0,
  }
}
