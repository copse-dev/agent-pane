import type { TodoItem } from './wire-types.ts'

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
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name !== 'list_dir' || !args || typeof args !== 'object') return args
  const a = args as Record<string, unknown>
  const path = typeof a['path'] === 'string' ? a['path'].trim() || '.' : '.'
  return { ...a, path }
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
  'You already explored this workspace. Use the tool results above — run the requested command with run_shell or write your final answer. Do not list the root directory again or re-read the same files.'

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
