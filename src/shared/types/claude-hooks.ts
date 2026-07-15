/**
 * Claude Code hooks (https://code.claude.com/docs/en/hooks).
 *
 * Defined under `hooks` in `~/.claude/settings.json`, project
 * `.claude/settings.json`, and `.claude/settings.local.json`. Schema differs from
 * Cursor's flat `hooks.json`: events nest matcher groups, each with an inner
 * `hooks` array of handlers (`type: "command" | …`).
 */

/** Hook events Copse understands from Claude settings (permission-only for now). */
export const CLAUDE_PERMISSION_HOOK_EVENTS = ['PreToolUse'] as const

export type ClaudePermissionHookEvent = (typeof CLAUDE_PERMISSION_HOOK_EVENTS)[number]

/** Claude PreToolUse permission decisions we honour. */
export const CLAUDE_PERMISSION_DECISIONS = ['allow', 'deny', 'ask', 'defer'] as const

export type ClaudePermissionDecision = (typeof CLAUDE_PERMISSION_DECISIONS)[number]
