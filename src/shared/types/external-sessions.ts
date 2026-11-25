import type { ExternalSessionSource, Thread } from '@copse/thread-store/thread-types.ts'

/**
 * One saved session of another coding tool (Claude Code or the Codex CLI) that
 * ran in a project's folder, as the import dialog lists it. Built by main from
 * the tool's own transcript files; nothing here is sent anywhere.
 */
export interface ExternalSessionSummary {
  source: ExternalSessionSource
  /** One-way key that names the session in an import request. */
  key: string
  /** The first prompt, shortened, or the tool's own summary when it wrote one. */
  title: string
  /** Where the session ran, relative to the project root (`''` for the root). */
  relativeCwd: string
  /** Git branch the session started on, when the tool recorded one. */
  gitBranch?: string
  startedAt: number
  updatedAt: number
  /** The Copse thread this session was already imported into, if any. */
  importedThreadId?: string
}

/** What a scan of the tools' session folders found for one project. */
export interface ExternalSessionList {
  sessions: ExternalSessionSummary[]
  /** Which tools had a session folder on this machine at all. */
  sourcesFound: ExternalSessionSource[]
}

export interface ExternalSessionImportResult {
  /** Threads created by this import, newest first, as metadata (`messagesLoaded: false`); opening one loads its transcript. */
  imported: Thread[]
  /** Sessions that were already threads, by key, and the thread they became. */
  alreadyImported: Array<{ key: string; threadId: string }>
  /** Sessions that could not be read, by key, with why. */
  failed: Array<{ key: string; reason: string }>
}
