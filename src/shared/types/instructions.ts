/** Summary of a project instruction file loaded into the system prompt. */
export interface ProjectInstructionSummary {
  /** Absolute path of the file on disk. */
  path: string
  /** Bare filename (e.g. `CLAUDE.md`). */
  name: string
  /** Byte length of the trimmed content fed to the prompt. */
  bytes: number
}
