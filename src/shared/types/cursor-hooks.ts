/**
 * Cursor agent hooks (https://cursor.com/docs/hooks).
 *
 * Hooks are user-provided scripts registered in a `hooks.json` file that Cursor —
 * and now Copse — spawn at points in the agent loop. They communicate over stdio
 * with JSON in both directions and can observe, block, or annotate agent actions.
 */

/** Hook lifecycle events Copse understands. Mirrors Cursor's event names exactly. */
export const CURSOR_HOOK_EVENTS = [
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
  'beforeSubmitPrompt',
  'afterFileEdit',
  'stop',
] as const

export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number]

/** Permission-gating hooks return a decision; observation hooks return nothing. */
export const CURSOR_PERMISSION_HOOK_EVENTS = [
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
] as const

export type CursorPermissionHookEvent = (typeof CURSOR_PERMISSION_HOOK_EVENTS)[number]

/** Where a hook definition came from — determines its trust tier. */
export type CursorHookScope = 'user' | 'project'

/** A single discovered hook command for diagnostics / a future Settings UI. */
export interface CursorHookSummary {
  event: CursorHookEvent
  /** The shell command Copse will spawn for this hook. */
  command: string
  /** Absolute path to the `hooks.json` that declared it. */
  source: string
  scope: CursorHookScope
}
