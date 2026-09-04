/** Where an instruction file lives: user-global or project/workspace-scoped. */
export type InstructionScope = 'global' | 'project'

/** Summary of a project instruction file loaded into the system prompt. */
export interface ProjectInstructionSummary {
  /** Absolute path of the file on disk. */
  path: string
  /** Bare filename (e.g. `CLAUDE.md`). */
  name: string
  /** Whether the file is user-global or project-scoped. */
  scope: InstructionScope
  /** Byte length of the trimmed content fed to the prompt. */
  bytes: number
  /** Whether the source was loaded into the current or most recently assembled prompt. */
  active: boolean
  /** Project trust gate, separate from conditional nested activation. */
  trusted: boolean
  /** Workspace-relative directory governed by a nested AGENTS.md. */
  scopePath?: string
  /** Name of the listed source this nested file repeats; its text is loaded once, via that one. */
  duplicateOf?: string
  /** Nested discovery stopped at a cap, so nested files may be missing from the list. */
  discoveryTruncated?: boolean
}
