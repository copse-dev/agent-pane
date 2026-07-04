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
}
