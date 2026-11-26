import type { ExternalSessionSource, Message } from '@shared/types'

/** A session file on disk, before it is read. */
export interface ExternalSessionFile {
  source: ExternalSessionSource
  path: string
  /** File modification time: when the tool last wrote to the session. */
  updatedAt: number
  bytes: number
}

/**
 * A session read off disk. `messages` is empty when only the header was read
 * (for the list); a full read fills it with the Copse transcript.
 */
export interface ParsedExternalSession {
  source: ExternalSessionSource
  /** The tool's own session id: what its agent resumes by. Kept in main only. */
  sessionId: string
  cwd: string
  gitBranch?: string
  title: string
  startedAt: number
  updatedAt: number
  messages: Message[]
}
