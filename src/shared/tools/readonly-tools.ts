import type { McpToolAnnotations } from '@shared/types/mcp.ts'

/**
 * Built-in tools allowed during a read-only agent run: read, search, git
 * inspection, skill reads, staged-diff inspection, and the explore subagent.
 *
 * This allow-list is the single source of truth. Anything not listed here (and
 * any MCP tool that is not provably read-only) is denied — see
 * {@link isToolAllowedInReadonlyMode}. Default-deny means new mutating tools are
 * blocked automatically without having to be enumerated.
 */
export const READONLY_AGENT_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'staged_diffs',
  'read_staged_diff',
  'read_skill',
  // Reports worktree/cache readiness without installing or modifying anything.
  'preflight_worktree',
  'explore',
  // Delegating to a user-authored subagent is itself non-mutating, and the
  // subagent cannot escape the run's read-only scope: that scope is ALS-based
  // and covers everything the run awaits, so each of the subagent's own tool
  // calls is gated by this same allow-list. Withholding `task` here would
  // instead block a read-only reviewer agent for no safety gain — unlike
  // `delegate_step`, whose whole purpose is to write files.
  'task',
  'ask_user',
  // Reading back stored OKF memories is non-mutating; `remember` (a write) stays
  // denied by default in read-only mode.
  'recall',
  // Snapshotting the user's open Shells tabs is read-only.
  'read_terminal',
  // Reading stills out of a video decodes in a hidden window and writes nothing.
  'video_frames',
])

export const READONLY_MODE_BLOCK_MESSAGE =
  'Blocked in read-only mode. Disable "Read-only agent mode" in Settings → Security to allow writes, shell, and network calls.'

/**
 * MCP tools are only allowed when the server flags them read-only and
 * non-destructive. These hints are advisory and server-controlled, so allowed
 * MCP tools still go through the normal approval gate — read-only mode never
 * auto-approves them.
 */
export function isMcpToolAllowedInReadonlyMode(annotations?: McpToolAnnotations): boolean {
  return !!annotations?.readOnlyHint && !annotations.destructiveHint
}

/** Whether a tool may run during a read-only agent run. Default-deny. */
export function isToolAllowedInReadonlyMode(
  toolName: string,
  opts?: { mcpAnnotations?: McpToolAnnotations | undefined },
): boolean {
  if (toolName.startsWith('mcp__')) return isMcpToolAllowedInReadonlyMode(opts?.mcpAnnotations)
  return READONLY_AGENT_TOOLS.has(toolName)
}

/** Returns a model-facing block reason, or null when the tool may run. */
export function getReadonlyToolBlockReason(
  toolName: string,
  opts?: { mcpAnnotations?: McpToolAnnotations | undefined },
): string | null {
  if (isToolAllowedInReadonlyMode(toolName, opts)) return null
  return `${toolName}: ${READONLY_MODE_BLOCK_MESSAGE}`
}
