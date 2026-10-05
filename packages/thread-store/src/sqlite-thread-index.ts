import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse, type JsonDecoder } from '@copse/std/safe-json.ts'
import { parseThreadMetaValue } from './thread-boundary.ts'
import type { Thread } from './thread-types.ts'
import { sortThreadsNewestFirst } from './thread-sort.ts'
import {
  commitProductionSchema,
  prProductionSchema,
  prRefSchema,
  prRelationKey,
  threadPrRelationships,
  type CommitProduction,
  type PrThreadRelationship,
  type ThreadPrRelationship,
} from './thread-pr-relations.ts'
import type { GithubPrRef } from './github-pr-url.ts'
import { toSideChatRow, type SideChatRow } from './side-chat.ts'
import type { ThreadBacklink } from './thread-links.ts'
import type { ThreadLink } from './thread-types.ts'

export const THREAD_INDEX_FILE = '.thread-index.sqlite'
// v2 adds the side_chats and links tables. An older index is incompatible, so the
// store discards and rebuilds it from the authoritative thread files.
const SCHEMA_VERSION = 2
const BATCH_SIZE = 128
const kindsSchema = z.array(z.enum(['produced', 'referenced', 'agent-linked']))
const threadRelationSchema = z.object({ pr: prRefSchema, kinds: kindsSchema })
const prRelationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  kinds: kindsSchema,
  productions: z.array(prProductionSchema),
})
const commitRelationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  evidence: z.array(commitProductionSchema),
})

function decode<T>(raw: unknown, decoder: JsonDecoder<T>): T {
  const value = typeof raw === 'string' ? safeJsonParse(raw, decoder) : null
  if (value === null) throw new Error('Invalid thread index payload')
  return value
}

/**
 * Disposable projection, never a transcript store. The caller serializes access
 * per project and guards the database and SQLite sidecar paths before opening.
 * Pending IDs commit BEFORE file writes; removing them shares the transaction
 * that updates the projection, so process-crash recovery cannot lose a change.
 */
export class SqliteThreadIndex {
  #db: DatabaseSync
  #putThread
  #deleteThread
  #putPr
  #putCommit
  #putPending
  #getPending
  #deletePending
  #readMetas
  #readPr
  #readThread
  #readCommit
  #readUnscanned
  #readUnscannedThread
  #putSideChat
  #putLink
  #readSideChats
  #readThreadLinks
  #readBacklinks

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    try {
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;')
      const version = this.#db.prepare('PRAGMA user_version').get()?.['user_version']
      if (version !== 0 && version !== SCHEMA_VERSION)
        throw new Error('Incompatible thread index schema')
      this.#db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS state (
          id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL, source_dir TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY, meta TEXT NOT NULL, has_messages INTEGER NOT NULL,
          archived INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pr_unscanned ON threads(id)
          WHERE archived=0 AND json_type(meta,'$.prRefs') IS NULL;
        CREATE TABLE IF NOT EXISTS pr_links (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          pr_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
          thread_payload TEXT NOT NULL, pr_payload TEXT NOT NULL,
          PRIMARY KEY(thread_id, pr_key)
        );
        CREATE INDEX IF NOT EXISTS pr_lookup ON pr_links(pr_key, thread_id);
        CREATE TABLE IF NOT EXISTS commit_links (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          repository TEXT NOT NULL, sha TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(thread_id, repository, sha)
        );
        CREATE INDEX IF NOT EXISTS commit_lookup ON commit_links(repository, sha, thread_id);
        CREATE TABLE IF NOT EXISTS side_chats (
          thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          parent_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS side_chat_parent ON side_chats(parent_id, thread_id);
        CREATE TABLE IF NOT EXISTS links (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, target TEXT NOT NULL, ordinal INTEGER NOT NULL,
          PRIMARY KEY(thread_id, kind, target)
        );
        CREATE INDEX IF NOT EXISTS link_lookup ON links(kind, target, thread_id);
        CREATE TABLE IF NOT EXISTS pending (thread_id TEXT PRIMARY KEY);
        PRAGMA user_version=${String(SCHEMA_VERSION)};
      `)
      const sourceDir = dirname(resolve(path))
      this.#db.prepare('INSERT OR IGNORE INTO state VALUES(1,0,?)').run(sourceDir)
      if (
        this.#db.prepare('SELECT source_dir FROM state WHERE id=1').get()?.['source_dir'] !==
        sourceDir
      )
        throw new Error('Thread index belongs to a different store')
      this.#putThread = this.#db.prepare(`
        INSERT INTO threads(id,meta,has_messages,archived) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,
          has_messages=excluded.has_messages, archived=excluded.archived
      `)
      this.#deleteThread = this.#db.prepare('DELETE FROM threads WHERE id=?')
      this.#putPr = this.#db.prepare('INSERT INTO pr_links VALUES(?,?,?,?,?)')
      this.#putCommit = this.#db.prepare('INSERT INTO commit_links VALUES(?,?,?,?)')
      this.#putPending = this.#db.prepare('INSERT OR IGNORE INTO pending VALUES(?)')
      this.#getPending = this.#db.prepare('SELECT thread_id FROM pending WHERE thread_id=?')
      this.#deletePending = this.#db.prepare('DELETE FROM pending WHERE thread_id=?')
      this.#readMetas = this.#db.prepare(`SELECT rowid AS cursor,meta,has_messages FROM threads
        WHERE rowid>? AND (? OR archived=0) ORDER BY rowid LIMIT ${String(BATCH_SIZE)}`)
      this.#readPr = this.#db.prepare(
        'SELECT pr_payload AS payload FROM pr_links WHERE pr_key=? ORDER BY thread_id',
      )
      this.#readThread = this.#db.prepare(
        'SELECT thread_payload AS payload FROM pr_links WHERE thread_id=? ORDER BY ordinal',
      )
      this.#readCommit = this.#db.prepare(
        'SELECT payload FROM commit_links WHERE repository=? AND sha=? ORDER BY thread_id',
      )
      this.#putSideChat = this.#db.prepare('INSERT INTO side_chats VALUES(?,?)')
      this.#putLink = this.#db.prepare('INSERT INTO links VALUES(?,?,?,?)')
      this.#readSideChats = this.#db.prepare(`SELECT t.meta AS meta FROM side_chats s
        JOIN threads t ON t.id=s.thread_id WHERE s.parent_id=? AND (? OR t.archived=0)
        ORDER BY s.thread_id`)
      this.#readThreadLinks = this.#db.prepare(
        'SELECT kind,target FROM links WHERE thread_id=? ORDER BY ordinal',
      )
      this.#readBacklinks = this.#db.prepare(`SELECT l.thread_id AS id, t.meta AS meta FROM links l
        JOIN threads t ON t.id=l.thread_id WHERE l.kind=? AND l.target=? AND t.archived=0
        ORDER BY l.thread_id`)
      const unscanned = "archived=0 AND json_type(meta,'$.prRefs') IS NULL"
      this.#readUnscanned = this.#db.prepare(`SELECT id FROM threads WHERE ${unscanned}`)
      this.#readUnscannedThread = this.#db.prepare(
        `SELECT id FROM threads WHERE id=? AND ${unscanned}`,
      )
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  get ready(): boolean {
    return this.#db.prepare('SELECT ready FROM state WHERE id=1').get()?.['ready'] === 1
  }

  close(): void {
    this.#db.close()
  }

  markPending(threadId: string): void {
    if (!this.#getPending.get(threadId)) this.#putPending.run(threadId)
  }

  pendingIds(): string[] {
    return this.#db
      .prepare('SELECT thread_id FROM pending')
      .all()
      .map((row) => {
        const id = row['thread_id']
        if (typeof id !== 'string') throw new Error('Invalid pending thread ID')
        return id
      })
  }

  unscannedPrRefIds(threadId?: string): string[] {
    const rows =
      threadId === undefined ? this.#readUnscanned.all() : this.#readUnscannedThread.all(threadId)
    return rows.map((row) => {
      const id = row['id']
      if (typeof id !== 'string') throw new Error('Invalid unscanned thread ID')
      return id
    })
  }

  /**
   * `fresh` means no row for this thread can exist yet (a rebuild just emptied the
   * tables), so the side-chat and link rows need no clearing first.
   */
  #upsert(thread: Thread, fresh = false): void {
    const { messages: _messages, messagesLoaded, ...meta } = thread
    this.#putThread.run(
      thread.id,
      JSON.stringify(meta),
      messagesLoaded === true ? 0 : 1,
      thread.archivedAt == null ? 0 : 1,
    )
    this.#db.prepare('DELETE FROM pr_links WHERE thread_id=?').run(thread.id)
    this.#db.prepare('DELETE FROM commit_links WHERE thread_id=?').run(thread.id)
    if (!fresh) {
      this.#db.prepare('DELETE FROM side_chats WHERE thread_id=?').run(thread.id)
      this.#db.prepare('DELETE FROM links WHERE thread_id=?').run(thread.id)
    }
    // Archived side chats stay listed (archived, not deleted); only PR/commit/link
    // claims are withheld from archived threads.
    if (thread.sideChat) this.#putSideChat.run(thread.id, thread.sideChat.parentThreadId)
    if (thread.archivedAt != null) return
    for (const [ordinal, link] of (thread.links ?? []).entries())
      this.#putLink.run(thread.id, link.kind, link.target, ordinal)
    for (const [ordinal, relation] of threadPrRelationships(thread).entries()) {
      const key = prRelationKey(relation.pr)
      const prPayload: PrThreadRelationship = {
        threadId: thread.id,
        title: thread.title,
        kinds: relation.kinds,
        productions: (thread.prProductions ?? []).filter((item) => prRelationKey(item.pr) === key),
      }
      this.#putPr.run(thread.id, key, ordinal, JSON.stringify(relation), JSON.stringify(prPayload))
    }
    const commits = new Map<string, CommitProduction[]>()
    for (const evidence of thread.commitProductions ?? []) {
      const key = `${evidence.repository}@${evidence.sha}`
      const entries = commits.get(key) ?? []
      entries.push(evidence)
      commits.set(key, entries)
    }
    for (const evidence of commits.values()) {
      const first = evidence[0]
      if (!first) continue
      this.#putCommit.run(
        thread.id,
        first.repository,
        first.sha,
        JSON.stringify({ threadId: thread.id, title: thread.title, evidence }),
      )
    }
  }

  /** Chunk CPU work so large rebuilds do not monopolize Electron's main loop. */
  async replaceAll(threads: readonly Thread[]): Promise<void> {
    this.#db.exec('UPDATE state SET ready=0 WHERE id=1')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.exec('DELETE FROM threads; DELETE FROM pending;')
      const seen = new Set<string>()
      for (let start = 0; start < threads.length; start += BATCH_SIZE) {
        for (const thread of threads.slice(start, start + BATCH_SIZE)) {
          // A repeated id is an update of the row just written, not a fresh insert.
          this.#upsert(thread, !seen.has(thread.id))
          seen.add(thread.id)
        }
        await setImmediate()
      }
      this.#db.exec('UPDATE state SET ready=1 WHERE id=1; COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  async repair(read: (id: string) => Promise<Thread | null>): Promise<void> {
    for (const id of this.pendingIds()) {
      const thread = await read(id)
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        if (thread) this.#upsert(thread)
        else this.#deleteThread.run(id)
        this.#deletePending.run(id)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
  }

  async metas(includeArchived = true): Promise<Thread[]> {
    const threads: Thread[] = []
    let cursor = 0
    for (;;) {
      const rows = this.#readMetas.all(cursor, includeArchived ? 1 : 0)
      if (!rows.length) break
      for (const row of rows) {
        const meta = decode(row['meta'], parseThreadMetaValue)
        const next = row['cursor']
        const hasMessages = row['has_messages']
        if (typeof next !== 'number' || (hasMessages !== 0 && hasMessages !== 1))
          throw new Error('Invalid thread index metadata row')
        cursor = next
        threads.push({ ...meta, messages: [], messagesLoaded: hasMessages === 0 })
      }
      await setImmediate()
    }
    return sortThreadsNewestFirst(threads)
  }

  /** Side chats of a thread, oldest first; archived ones are opt-in. */
  sideChatsOf(parentId: string, includeArchived = false): SideChatRow[] {
    return this.#readSideChats
      .all(parentId, includeArchived ? 1 : 0)
      .map((row) => {
        const meta = decode(row['meta'], parseThreadMetaValue)
        const sideChat = toSideChatRow({ ...meta, messages: [] })
        if (!sideChat) throw new Error('Invalid side chat row')
        return sideChat
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** Links one thread has mentioned, in order of first appearance. */
  linksOf(threadId: string): ThreadLink[] {
    return this.#readThreadLinks.all(threadId).map((row) => {
      const kind = row['kind']
      const target = row['target']
      if ((kind !== 'url' && kind !== 'thread') || typeof target !== 'string')
        throw new Error('Invalid thread link row')
      return { kind, target }
    })
  }

  /** Active threads that mention `target`. */
  backlinks(kind: ThreadLink['kind'], target: string): ThreadBacklink[] {
    return this.#readBacklinks.all(kind, target).map((row) => {
      const meta = decode(row['meta'], parseThreadMetaValue)
      return { threadId: meta.id, title: meta.title }
    })
  }

  forPr(pr: GithubPrRef): PrThreadRelationship[] {
    return this.#readPr
      .all(prRelationKey(pr))
      .map((row) => decode(row['payload'], decodeWithSchema(prRelationSchema)))
  }

  forThread(threadId: string): ThreadPrRelationship[] {
    return this.#readThread
      .all(threadId)
      .map((row) => decode(row['payload'], decodeWithSchema(threadRelationSchema)))
  }

  forCommit(
    repository: string,
    sha: string,
  ): Array<{
    threadId: string
    title: string
    evidence: CommitProduction[]
  }> {
    return this.#readCommit
      .all(repository.toLowerCase(), sha.toLowerCase())
      .map((row) => decode(row['payload'], decodeWithSchema(commitRelationSchema)))
  }
}
