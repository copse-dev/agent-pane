import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  ThreadPrRelationshipIndex,
  threadPrRelationships,
  prRelationKey,
  prRefSchema,
  prProductionSchema,
  commitProductionSchema,
  type RelationshipThread,
} from '@copse/thread-store/thread-pr-relations.ts'
import type { GithubPrRef } from '@copse/thread-store/github-pr-url.ts'

const sqlRowSchema = z.object({ data: z.string() })

export const projectionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    archivedAt: z.number().optional(),
    prRefs: prRefSchema.array().optional(),
    prProductions: prProductionSchema.array().optional(),
    commitProductions: commitProductionSchema.array().optional(),
    remoteAgentLink: z
      .object({
        provider: z.enum(['cursor', 'anthropic']),
        agentId: z.string(),
        prUrl: z.string().optional(),
        createdAt: z.number(),
      })
      .optional(),
  })
  .transform((value): RelationshipThread => ({
    id: value.id,
    title: value.title,
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt }),
    ...(value.prRefs === undefined ? {} : { prRefs: value.prRefs }),
    ...(value.prProductions === undefined ? {} : { prProductions: value.prProductions }),
    ...(value.commitProductions === undefined
      ? {}
      : { commitProductions: value.commitProductions }),
    ...(value.remoteAgentLink
      ? {
          remoteAgentLink: {
            provider: value.remoteAgentLink.provider,
            agentId: value.remoteAgentLink.agentId,
            createdAt: value.remoteAgentLink.createdAt,
            ...(value.remoteAgentLink.prUrl === undefined
              ? {}
              : { prUrl: value.remoteAgentLink.prUrl }),
          },
        }
      : {}),
  }))

/** Benchmark candidate: a rebuildable SQLite projection, not production app storage. */
export class SqlitePrRelationshipIndex {
  #db: DatabaseSync
  #statements = new Map<string, StatementSync>()
  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (!statement) {
      statement = this.#db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }
  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
      CREATE TABLE IF NOT EXISTS pr_links(pr_key TEXT, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, PRIMARY KEY(pr_key, thread_id)) STRICT;
      CREATE INDEX IF NOT EXISTS pr_links_by_thread ON pr_links(thread_id);
      CREATE TABLE IF NOT EXISTS commit_links(commit_key TEXT, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, PRIMARY KEY(commit_key, thread_id)) STRICT;
      CREATE INDEX IF NOT EXISTS commit_links_by_thread ON commit_links(thread_id);
    `)
  }
  close(): void {
    this.#db.close()
  }
  #write(thread: RelationshipThread): void {
    this.#statement('DELETE FROM threads WHERE id = ?').run(thread.id)
    if (thread.archivedAt != null) return
    this.#statement('INSERT INTO threads VALUES (?, ?)').run(
      thread.id,
      JSON.stringify(projectionSchema.parse(thread)),
    )
    const prInsert = this.#statement('INSERT INTO pr_links VALUES (?, ?)')
    for (const { pr } of threadPrRelationships(thread)) prInsert.run(prRelationKey(pr), thread.id)
    const commitInsert = this.#statement('INSERT OR IGNORE INTO commit_links VALUES (?, ?)')
    for (const commit of thread.commitProductions ?? [])
      commitInsert.run(`${commit.repository}@${commit.sha}`, thread.id)
  }
  #transaction(operation: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
  replaceAll(threads: readonly RelationshipThread[]): void {
    this.#transaction(() => {
      this.#db.exec('DELETE FROM threads')
      for (const thread of threads) this.#write(thread)
    })
  }
  upsert(thread: RelationshipThread): void {
    this.#transaction(() => {
      this.#write(thread)
    })
  }
  #read(sql: string, key: string): RelationshipThread[] {
    return this.#statement(sql)
      .all(key)
      .map((row) => {
        const data = sqlRowSchema.parse(row).data
        const parsed = safeJsonParse(data, decodeWithSchema(projectionSchema))
        if (!parsed) throw new Error('Invalid SQLite projection; rebuild required')
        return parsed
      })
  }
  forPr(pr: GithubPrRef): ReturnType<ThreadPrRelationshipIndex['forPr']> {
    const threads = this.#read(
      'SELECT data FROM threads JOIN pr_links ON threads.id = pr_links.thread_id WHERE pr_key = ? ORDER BY id',
      prRelationKey(pr),
    )
    const key = prRelationKey(pr)
    return threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      kinds:
        threadPrRelationships(thread).find((item) => prRelationKey(item.pr) === key)?.kinds ?? [],
      productions: (thread.prProductions ?? []).filter((item) => prRelationKey(item.pr) === key),
    }))
  }
  forThread(id: string): ReturnType<ThreadPrRelationshipIndex['forThread']> {
    const threads = this.#read('SELECT data FROM threads WHERE id = ?', id)
    return threads[0] ? threadPrRelationships(threads[0]) : []
  }
  forCommit(repository: string, sha: string): ReturnType<ThreadPrRelationshipIndex['forCommit']> {
    const threads = this.#read(
      'SELECT data FROM threads JOIN commit_links ON threads.id = commit_links.thread_id WHERE commit_key = ? ORDER BY id',
      `${repository.toLowerCase()}@${sha.toLowerCase()}`,
    )
    return threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      evidence: (thread.commitProductions ?? []).filter(
        (item) => item.repository === repository.toLowerCase() && item.sha === sha.toLowerCase(),
      ),
    }))
  }
}
