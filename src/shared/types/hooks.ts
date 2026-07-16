/**
 * Shared hook summary for Settings → Sources and `hooks:list` IPC.
 *
 * Cursor hooks (`hooks.json`) and Claude Code hooks (`.claude/settings.json`)
 * both surface here; execution stays in their respective runners.
 */

/** Where a hook definition came from — determines its trust tier. */
export type HookScope = 'user' | 'project'

/** Which product's on-disk schema produced this hook. */
export type HookFamily = 'cursor' | 'claude'

/** A single discovered hook command for diagnostics / Settings → Sources. */
export interface HookSummary {
  family: HookFamily
  /** Lifecycle event name (Cursor or Claude), e.g. `beforeShellExecution` / `PreToolUse`. */
  event: string
  /** The shell command Copse will spawn for this hook. */
  command: string
  /** Absolute path to the config file that declared it. */
  source: string
  scope: HookScope
  /**
   * Claude matcher group filter (tool-name pattern). Omitted for Cursor hooks and
   * for Claude groups with no matcher / `"*"`.
   */
  matcher?: string
  /**
   * Whether Copse actually acts on this event. Declared-but-unwired events (e.g.
   * Cursor `stop`) surface as `false` so Sources can badge them "unsupported"
   * rather than looking active. Absent means "supported" (back-compat).
   */
  supported?: boolean
  /**
   * First runtime failure observed this session (crash / timeout / invalid JSON),
   * surfaced as a per-hook error indicator. Never affects fail-open semantics.
   */
  lastError?: string
}

/** A malformed / unrecognised `hooks.json` entry, surfaced as a warning row. */
export interface HookValidationWarning {
  /** Event name the bad entry was under, when known. */
  event?: string
  /** Human-readable problem (e.g. "unknown event", "missing command"). */
  message: string
  /** Absolute path to the config file that declared it. */
  source: string
  scope: HookScope
}

/** `hooks:list` payload: the discovered hooks plus any authoring-time warnings. */
export interface HooksListResult {
  hooks: HookSummary[]
  warnings: HookValidationWarning[]
}
