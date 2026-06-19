import type { AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'

export const CONTEXT_TRIM_ACTIVITY = 'Shortened earlier messages'

export function runningToolName(thread: Thread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    for (let j = m.toolCalls.length - 1; j >= 0; j--) {
      const tc = m.toolCalls[j]!
      if (tc.status === 'running') return tc.name
    }
  }
  return null
}

export function agentActivityLabel(thread: Thread | undefined, writing: boolean): string | null {
  if (!thread || thread.status !== 'running') return null
  const tool = runningToolName(thread)
  if (tool) return `Running ${tool}…`
  if (writing) return 'Writing…'
  return 'Thinking…'
}

export function syncAgentActivity(store: AppStore, threadId: string, writing: boolean): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  store.emit('agent_activity', threadId, agentActivityLabel(thread, writing))
}
