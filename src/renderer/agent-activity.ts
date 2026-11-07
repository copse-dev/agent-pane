import type { AppStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { CommandPhaseState } from '@copse/agent/wire-types.ts'
import { getToolDisplayName } from '@shared/tools/tool-display.ts'
import { acpDelegateKind, isAcpDelegateToolCall } from '@shared/tools/copse-tool-call.ts'
import { formatTodoProgress } from '@shared/todos/todo-logic.ts'

export const CONTEXT_TRIM_ACTIVITY = 'Shortened earlier messages'

export function promptProgressLabel(fraction: number): string {
  if (!Number.isFinite(fraction)) return 'Processing prompt…'
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return `Processing prompt… ${percent.toString()}%`
}

type RunningActivity =
  | { kind: 'tool'; name: string; commandPhase?: CommandPhaseState }
  // ACP agents (e.g. Claude Code) dispatch their own subagents as one or more
  // plain tool calls, with no session to count them through like the native
  // `task` tool's `subagent`. Several can run at once on the same message, so
  // this counts them directly instead of reporting only the last one found.
  | { kind: 'delegates'; count: number; soleKind: string | null }

function findRunningActivity(thread: Thread): RunningActivity | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]
    if (!m) continue
    const toolCalls = m.toolCalls
    const runningDelegates = toolCalls.filter(
      (tc) => tc.status === 'running' && isAcpDelegateToolCall(tc),
    )
    if (runningDelegates.length > 0) {
      const kinds = new Set(runningDelegates.map((tc) => acpDelegateKind(tc)))
      const [soleKind] = kinds
      return {
        kind: 'delegates',
        count: runningDelegates.length,
        soleKind: kinds.size === 1 ? (soleKind ?? null) : null,
      }
    }
    for (let j = toolCalls.length - 1; j >= 0; j--) {
      const tc = toolCalls[j]
      if (!tc) continue
      if (tc.status === 'running') {
        return {
          kind: 'tool',
          name: tc.name === 'explore' ? 'explore' : tc.name,
          ...(tc.commandPhase ? { commandPhase: tc.commandPhase.state } : {}),
        }
      }
      if (tc.subagent?.status === 'running') return { kind: 'tool', name: 'explore' }
    }
  }
  return null
}

/** A command that has not launched yet is not "Running command" (#3956). */
function commandWaitLabel(phase: CommandPhaseState | undefined): string | null {
  if (phase === 'awaiting_approval') return 'Waiting for approval'
  if (phase === 'starting') return 'Starting command'
  return null
}

function delegateActivityLabel(count: number, soleKind: string | null): string {
  if (count === 1) return soleKind ? `Running ${soleKind}` : getToolDisplayName('task', 'running')
  return soleKind
    ? `Running ${String(count)} ${soleKind} agents`
    : `Running ${String(count)} agents`
}

export function agentActivityLabel(thread: Thread | undefined, writing: boolean): string | null {
  if (!thread || thread.status !== 'running') return null
  const todoLabel = thread.todos?.length ? formatTodoProgress(thread.todos) : null
  const activity = findRunningActivity(thread)
  if (activity) {
    // Progressive form while in flight — avoids "Running Explored files…".
    const base =
      activity.kind === 'delegates'
        ? `${delegateActivityLabel(activity.count, activity.soleKind)}…`
        : `${commandWaitLabel(activity.commandPhase) ?? getToolDisplayName(activity.name, 'running')}…`
    return todoLabel ? `${base} (${todoLabel})` : base
  }
  if (writing) return todoLabel ? `Writing… (${todoLabel})` : 'Writing…'
  return todoLabel ? `Reasoning… (${todoLabel})` : 'Reasoning…'
}

/** Emits the thread's current activity label, and returns what it emitted. */
export function syncAgentActivity(
  store: AppStore,
  threadId: string,
  writing: boolean,
): string | null {
  const thread = getThreadById(store, threadId)
  const label = agentActivityLabel(thread, writing)
  store.emit('agent_activity', threadId, label)
  return label
}
