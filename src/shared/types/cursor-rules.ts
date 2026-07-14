/**
 * Cursor project-rule activation kinds (issue #636). Mirrors Cursor's four
 * `.mdc` rule types: Always / Auto-Attached / Agent-Requested / Manual.
 */
export type CursorRuleKind = 'always' | 'auto' | 'agent' | 'manual'

/** Summary of a discovered `.cursor/rules/*.mdc` (or legacy `.cursorrules`) entry. */
export interface CursorRuleSummary {
  /** Absolute path of the rule file. */
  path: string
  /** Path relative to the workspace root (e.g. `.cursor/rules/style.mdc`). */
  name: string
  /** Activation kind. */
  kind: CursorRuleKind
  /** Byte length of the rule body (frontmatter stripped). */
  bytes: number
  /** Frontmatter description, when present. */
  description?: string
  /** Glob patterns for auto-attached rules. */
  globs?: string[]
}
