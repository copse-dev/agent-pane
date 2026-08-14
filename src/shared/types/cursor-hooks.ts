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
  'preToolUse',
  'beforeSubmitPrompt',
  'afterFileEdit',
  'afterShellExecution',
  'afterMCPExecution',
  'postToolUse',
  'postToolUseFailure',
  'stop',
  'subagentStart',
  'subagentStop',
  'sessionStart',
] as const

export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number]

/**
 * Permission-gating hooks return a decision; observation hooks return nothing.
 * These are the **dedicated** pre-tool flavors, each gating one class of tool.
 * The generic {@link CURSOR_GENERIC_TOOL_GATE_EVENT} gates every tool and is
 * tracked separately because it has no tool → event mapping.
 */
export const CURSOR_PERMISSION_HOOK_EVENTS = [
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
] as const

export type CursorPermissionHookEvent = (typeof CURSOR_PERMISSION_HOOK_EVENTS)[number]

/** Whether an event is one of the permission-gating hooks (shell / MCP / read). */
export function isCursorPermissionHookEvent(
  event: CursorHookEvent,
): event is CursorPermissionHookEvent {
  return (CURSOR_PERMISSION_HOOK_EVENTS as readonly string[]).includes(event)
}

/**
 * Cursor's **generic** pre-tool gate — the pre-side twin of `postToolUse`. Where
 * the dedicated flavors above each cover one tool class, `preToolUse` fires for
 * *every* tool, with the matcher tested against Cursor's tool-type token
 * (`Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<tool_name>`). It
 * maps onto the same canonical `toolGate` event as the dedicated flavors — a
 * payload flavor, not a separate canonical event — so a shell call can invoke
 * both `beforeShellExecution` and `preToolUse` with their distinct stdin shapes,
 * exactly as `afterShellExecution` + `postToolUse` already do on the post side.
 */
export const CURSOR_GENERIC_TOOL_GATE_EVENT = 'preToolUse' as const

/** Every Cursor event that maps onto the canonical `toolGate` (dedicated + generic). */
export const CURSOR_TOOL_GATE_HOOK_EVENTS = [
  ...CURSOR_PERMISSION_HOOK_EVENTS,
  CURSOR_GENERIC_TOOL_GATE_EVENT,
] as const

export type CursorToolGateHookEvent = (typeof CURSOR_TOOL_GATE_HOOK_EVENTS)[number]

/**
 * Cursor post-tool events mapped onto canonical `afterToolUse`. The dedicated
 * shell/MCP flavors and generic success/failure flavors share one fire point;
 * the generic `postToolUse` response may queue `additional_context`.
 */
export const CURSOR_AFTER_TOOL_HOOK_EVENTS = [
  'afterShellExecution',
  'afterMCPExecution',
  'postToolUse',
  'postToolUseFailure',
] as const

export type CursorAfterToolHookEvent = (typeof CURSOR_AFTER_TOOL_HOOK_EVENTS)[number]

/**
 * Events Copse actually fires (vs parsed for discovery only). The permission
 * gates and the generic `preToolUse` gate, plus `beforeSubmitPrompt` (B1 — compose path), `afterFileEdit`
 * (B2 — the diff-queue / write-tool site), `stop` (B3 — fired the moment agent
 * work stops, at turn end or abort), `subagentStart` / `subagentStop`
 * (D1 — the subagent spawn gate + detached completion, matcher on subagent type),
 * and `afterShellExecution` / `afterMCPExecution` / `postToolUse` /
 * `postToolUseFailure` (post-tool observations, flavors of the canonical
 * `afterToolUse`, dispatched detached with a capped output snapshot), and
 * `sessionStart` (H4 — fire-and-forget on a new
 * conversation's first turn; its `env` output propagates to later hook spawns).
 */
export const CURSOR_WIRED_HOOK_EVENTS = [
  ...CURSOR_TOOL_GATE_HOOK_EVENTS,
  'beforeSubmitPrompt',
  'afterFileEdit',
  'stop',
  'subagentStart',
  'subagentStop',
  'sessionStart',
  ...CURSOR_AFTER_TOOL_HOOK_EVENTS,
] as const

/** Whether Copse actually fires this event (drives the Sources "supported" badge). */
export function isCursorWiredHookEvent(event: CursorHookEvent): boolean {
  return (CURSOR_WIRED_HOOK_EVENTS as readonly string[]).includes(event)
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
   * Whether Copse actually fires this event. Declared-but-unwired events are
   * still discovered so the Sources panel can badge them "unsupported" instead
   * of looking active. `beforeSubmitPrompt` became wired in B1; `afterFileEdit`
   * in B2 (the diff-queue / write-tool site); `stop` in B3 (turn end / abort).
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
