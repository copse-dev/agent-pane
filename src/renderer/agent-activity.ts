import type { AppStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { getToolDisplayName } from '@shared/tools/tool-display.ts'
import { formatTodoProgress } from '@shared/todos/todo-logic.ts'

export const CONTEXT_TRIM_ACTIVITY = 'Shortened earlier messages'

/**
 * Label for the prefill phase shown on the live status line. `fraction` (0–1)
 * is rendered as a percentage when the provider reports it (LM Studio's native
 * progress events); without it the label is the indeterminate "Processing
 * prompt…".
 */
export function promptProgressLabel(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return 'Processing prompt…'
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return `Processing prompt… ${pct.toString()}%`
}

export function runningToolName(thread: Thread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]
    if (!m) continue
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    const toolCalls = m.toolCalls ?? []
    for (let j = toolCalls.length - 1; j >= 0; j--) {
      const tc = toolCalls[j]
      if (!tc) continue
      if (tc.status === 'running') {
        return tc.name === 'explore' ? 'explore' : tc.name
      }
      if (tc.subagent?.status === 'running') return 'explore'
    }
  }
  return null
}

export function agentActivityLabel(thread: Thread | undefined, writing: boolean): string | null {
  if (!thread || thread.status !== 'running') return null
  const todoLabel = thread.todos?.length ? formatTodoProgress(thread.todos) : null
  const tool = runningToolName(thread)
  if (tool) {
    const base = `Running ${getToolDisplayName(tool)}…`
    return todoLabel ? `${base} (${todoLabel})` : base
  }
  if (writing) return todoLabel ? `Writing… (${todoLabel})` : 'Writing…'
  return todoLabel ? `Thinking… (${todoLabel})` : 'Thinking…'
}

export function syncAgentActivity(store: AppStore, threadId: string, writing: boolean): void {
  const thread = getThreadById(store, threadId)
  store.emit('agent_activity', threadId, agentActivityLabel(thread, writing))
}
