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

/** Whether an event is actually wired into Copse (vs parsed for discovery only). */
export function isCursorPermissionHookEvent(
  event: CursorHookEvent,
): event is CursorPermissionHookEvent {
  return (CURSOR_PERMISSION_HOOK_EVENTS as readonly string[]).includes(event)
}

/** Where a hook definition came from — determines its trust tier. */
export type CursorHookScope = 'user' | 'project'

/** A single discovered hook command for diagnostics / the Sources panel. */
export interface CursorHookSummary {
  event: CursorHookEvent
  /** The shell command Copse will spawn for this hook. */
  command: string
  /** Absolute path to the `hooks.json` that declared it. */
  source: string
  scope: CursorHookScope
  /**
   * Whether Copse actually fires this event. Declared-but-unwired events
   * (`beforeSubmitPrompt`, `afterFileEdit`, `stop`) are discovered so the
   * Sources panel can badge them "unsupported" instead of looking active.
   */
  supported: boolean
  /**
   * First runtime failure of this hook this session (crash / timeout /
   * unparseable response — the fail-open paths), deduped per command+event.
   */
  lastError?: string
}

/**
 * A per-entry authoring problem found while parsing a `hooks.json` (unknown
 * event, missing command, malformed file). Warn-level lint only — parsing
 * stays non-fatal and never gates loading the valid entries.
 */
export interface CursorHookValidationWarning {
  /** Absolute path to the `hooks.json` the problem was found in. */
  source: string
  scope: CursorHookScope
  message: string
}

/** Result of hook discovery: valid hooks plus per-entry validation warnings. */
export interface CursorHooksListResult {
  hooks: CursorHookSummary[]
  warnings: CursorHookValidationWarning[]
}
