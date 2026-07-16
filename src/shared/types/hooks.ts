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
}
