/** When on, parent turns delegate reads/searches to `explore`/`investigate_ci` subagents. */
export const SUBAGENTS_ENABLED_SETTING = 'subagentsEnabled'

/**
 * Default off so native Copse exposes direct read/search tools (Read/Grep-style),
 * matching typical ACP coding agents and reducing `run_shell` fallback for file
 * work. Enable in Settings → Local models when you want summarized exploration.
 */
export const SUBAGENTS_ENABLED_DEFAULT = false
