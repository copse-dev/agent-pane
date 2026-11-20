import type { Message } from '@shared/types'

interface Entry {
  revision: string
  messages: Promise<Message[]>
}

/**
 * A paired phone polls one open thread every few seconds, and asks for each of
 * its images separately. Folding the transcript from disk for every one of
 * those requests costs the desktop's main process a full read of the thread,
 * however long, to return an answer that almost never changed.
 *
 * Keep the last few folded transcripts while the store says they are current
 * (see `threadReadRevision`). A transcript can hold megabytes of tool output
 * and image data, so the cache is small and empties itself once no phone has
 * read for a while.
 */
export class MobileThreadReads {
  private readonly entries = new Map<string, Entry>()
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly revision: (projectId: string, threadId: string) => Promise<string>
  private readonly load: (projectId: string, threadId: string) => Promise<Message[]>
  private readonly limit: number
  private readonly idleMs: number

  constructor(
    revision: (projectId: string, threadId: string) => Promise<string>,
    load: (projectId: string, threadId: string) => Promise<Message[]>,
    options: { limit?: number; idleMs?: number } = {},
  ) {
    this.revision = revision
    this.load = load
    this.limit = options.limit ?? 2
    this.idleMs = options.idleMs ?? 60_000
  }

  async read(projectId: string, threadId: string): Promise<Message[]> {
    const key = `${projectId}\0${threadId}`
    // The revision is taken before the load it labels: a write in between
    // leaves newer messages under an older revision, never the reverse.
    const revision = await this.revision(projectId, threadId)
    this.touch()
    const cached = this.entries.get(key)
    if (cached?.revision === revision) {
      // Refresh recency so the thread a phone is reading outlives a one-off read.
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.messages
    }
    const entry: Entry = { revision, messages: this.load(projectId, threadId) }
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    try {
      return await entry.messages
    } catch (error) {
      // A failed read is not an answer to keep; the next request tries again.
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  private touch(): void {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = null
      this.entries.clear()
    }, this.idleMs)
    // Holding a transcript must never hold the app open.
    this.idle.unref()
  }
}
