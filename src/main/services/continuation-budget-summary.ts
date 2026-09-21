import {
  DEFAULT_CONTINUATION_BUDGET,
  type ContinuationGrantReason,
} from '@copse/agent/hooks/continuation-budget.ts'
import type { TodoItem } from '@copse/agent/wire-types.ts'

export type ContinuationGrantCounts = Record<ContinuationGrantReason, number>

const MAX_VISIBLE_TODOS = 8
const MAX_TODO_CHARS = 160

const REASON_LABELS: Readonly<Record<ContinuationGrantReason, string>> = {
  'todo-closeout': 'todo closeout',
  'pre-review-todo': 'pre-review plan reconciliation',
  'post-review-remediation': 'review remediation',
}
const GRANT_REASONS = [
  'todo-closeout',
  'pre-review-todo',
  'post-review-remediation',
] as const satisfies readonly ContinuationGrantReason[]

function boundedTodoContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim() || '(untitled item)'
  return normalized.length <= MAX_TODO_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TODO_CHARS - 1).trimEnd()}…`
}

function todoStatus(status: TodoItem['status']): 'In progress' | 'Pending' {
  return status === 'in_progress' ? 'In progress' : 'Pending'
}

/**
 * Explain a spent turn-tree budget using only recorded grants and live plan
 * state. No model is called: the summary must remain available precisely when
 * another automatic turn is forbidden.
 */
export function continuationBudgetExhaustedSummary(
  todos: readonly TodoItem[],
  grants: Readonly<ContinuationGrantCounts>,
  terminal: { remaining: number; aborted: boolean; failed: boolean },
): string | null {
  if (terminal.remaining > 0 || terminal.aborted || terminal.failed) return null
  const open = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')
  if (open.length === 0) return null

  const visible = open.slice(0, MAX_VISIBLE_TODOS)
  const todoLines = visible.map(
    (todo) => `- ${todoStatus(todo.status)}: ${boundedTodoContent(todo.content)}`,
  )
  if (visible.length < open.length) {
    todoLines.push(`- ${String(open.length - visible.length)} more open plan items`)
  }

  const grantLines = GRANT_REASONS.filter((reason) => grants[reason] > 0).map(
    (reason) => `- ${REASON_LABELS[reason]}: ${String(grants[reason])}`,
  )
  const grantSummary =
    grantLines.length === 0
      ? 'No new automatic continuation allowances were granted during this run because the turn tree was already at its limit.'
      : ['Continuation allowances granted during this run:', ...grantLines].join('\n')

  return [
    `Copse reached the automatic continuation limit of ${String(DEFAULT_CONTINUATION_BUDGET)} for this turn. The plan still has open items:`,
    ...todoLines,
    '',
    grantSummary,
    '',
    'The limit stops more automatic turns. Review the remaining items and the tool output above, then give the agent new direction or send Continue to start a fresh turn.',
  ].join('\n')
}
