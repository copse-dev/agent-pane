import type { TodoItem } from './wire-types.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/** Tools that only gather context — repeating them often indicates a stuck loop. */
export const EXPLORE_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'find_files',
  'search_code',
  'search_codebase',
])

export function toolCallFingerprint(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name !== 'list_dir' || !isRecord(args)) return args
  const path = typeof args['path'] === 'string' ? args['path'].trim() || '.' : '.'
  return { ...args, path }
}

export function isDuplicateExploreCall(
  name: string,
  args: unknown,
  recentFingerprints: readonly string[],
): boolean {
  if (!EXPLORE_TOOL_NAMES.has(name)) return false
  const fp = toolCallFingerprint(name, normalizeExploreArgs(name, args))
  return recentFingerprints.includes(fp)
}

export const LOOP_NUDGE_USER_MESSAGE =
  'Exploration is over. Do not call read, list, or search tools, and do not use run_shell or edit tools to inspect files. Use the results already gathered. If the user asked only for analysis, answer now. Otherwise perform only the requested command or edit, then answer.'

export const STUCK_FINALIZE_NUDGE =
  'Stop calling tools. Write a clear final answer for the user based on the conversation so far.'

export const DUPLICATE_TOOL_RESULT_PREFIX =
  '[Duplicate tool call skipped — same arguments as a recent step. Use prior results, run_shell if needed, or answer in text.]'

/**
 * True while any todo is still pending or in progress. The `todo-finalize-closeout`
 * hook (and the closeout loop) use this so a run does not end with the plan
 * half-done.
 */
export function hasOpenTodos(todos: readonly TodoItem[]): boolean {
  return todos.some((t) => t.status === 'pending' || t.status === 'in_progress')
}

/** Max tool-enabled closeout turns while open todos remain at finalize. */
export const MAX_TODO_CLOSEOUT_ATTEMPTS = 3

export const OPEN_TODOS_FINALIZE_NUDGE = `You still have open todos in the plan. Before finishing:
1. Call update_todos (merge=true) to mark each finished item completed or cancel items you will not do.
2. If work remains, continue the pending/in_progress items — do not stop with open todos.
Do not reply with plain text claiming todos are done; the plan only updates via update_todos.`

export const OPEN_TODOS_FINALIZE_NUDGE_STRICT = `Open todos remain and were not updated. You MUST call update_todos now:
- merge=true, patch each item by id with status completed or cancelled, OR
- continue executing the remaining pending/in_progress work, then update_todos.
Plain-text claims that work is done are not accepted — update_todos is required.`

export const OPEN_TODOS_STILL_OPEN_MESSAGE =
  'Note: the task plan still has open items — the agent did not reconcile todos before finishing.'

/**
 * Cap on how many open-todo titles the budget-exhaustion note (below) lists by
 * name, so a plan with dozens of items doesn't turn the note into a wall of
 * text — a handful is enough to tell the human what is still blocking.
 */
export const MAX_BUDGET_EXHAUSTED_NOTE_TODOS = 5

/**
 * The note surfaced when a turn tree's shared auto-continuation budget
 * (decision 5) runs out while todos are still open — the closeout loop
 * (`todo-finalize-closeout`, `run-agent-loop.ts`) and the pre-review todo gate
 * (`runPreReviewTodoGate`, `post-turn-orchestration.ts`) both draw
 * machine-initiated turns from this one pool, and previously each stopped
 * silently once it ran out (#1410). This names the actual blocker — which
 * todos, how many closeout attempts ran, whether the last one did anything —
 * instead of a generic "still open" line, so a human "continue" is informed
 * rather than blindly re-arming the same failure.
 */
export function buildBudgetExhaustedTodoNote(
  openTodos: readonly TodoItem[],
  attemptsRun: number,
  lastAttemptMadeEdits: boolean,
): string {
  const shown = openTodos.slice(0, MAX_BUDGET_EXHAUSTED_NOTE_TODOS)
  const remainder = openTodos.length - shown.length
  const todoLines = shown.map((todo) => `- ${todo.content}`).join('\n')
  const todoList = remainder > 0 ? `${todoLines}\n- …and ${String(remainder)} more` : todoLines
  const attemptsSummary =
    attemptsRun === 0
      ? 'No closeout attempt ran before the budget ran out.'
      : `${String(attemptsRun)} closeout attempt${attemptsRun === 1 ? '' : 's'} ran; the last one ${
          lastAttemptMadeEdits ? 'called tools but did not finish the plan' : 'made no tool calls'
        }.`
  return (
    'Note: the auto-continuation budget for this message is used up, so the agent stopped with ' +
    'open todos still on the plan:\n' +
    `${todoList}\n` +
    `${attemptsSummary} Sending another message starts a fresh turn and re-arms the budget.`
  )
}
