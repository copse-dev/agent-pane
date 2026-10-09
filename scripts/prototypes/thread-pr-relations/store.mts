import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export interface ThreadRef {
  projectId: string
  threadId: string
}

export interface PrRef {
  /** Canonical host/owner/repo, including the host for enterprise repositories. */
  repository: string
  number: number
}

const threadRow = z.object({ projectId: z.string(), threadId: z.string(), title: z.string() })
const relationRow = threadRow.extend({ kind: z.enum(['referenced', 'created', 'contributed']) })
const prRow = z.object({ repository: z.string(), number: z.number().int().positive() })
const commitRow = z.object({ sha: z.string() })
const snapshotRow = z.object({ observedAt: z.number().nullable() })
const evidenceRow = threadRow.extend({
  eventId: z.string(),
  runId: z.string(),
  observedAt: z.number(),
})

type Relationship = z.infer<typeof relationRow>['kind']
interface PrView extends PrRef {
  relatedThreads: Array<{ threadId: string; title: string; relationships: Relationship[] }>
  commitsObservedAt: number | null
  commits: Array<{
    sha: string
    attribution: 'recorded' | 'unknown'
    evidence: Array<z.infer<typeof evidenceRow>>
  }> | null
}
interface ThreadView extends ThreadRef {
  title: string
  pullRequests: Array<PrRef & { relationships: Relationship[] }>
}

function repositoryKey(repository: string): string {
  const key = repository.trim().toLowerCase()
  if (!/^[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(key)) {
    throw new Error('Expected repository identity host/owner/repo')
  }
  return key
}

function commitSha(sha: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(sha)) {
    throw new Error('Expected full Git commit SHA')
  }
  return sha.toLowerCase()
}

/** Isolated design spike. Production ingestion must authenticate its event sources. */
export class ThreadPrRelations {
  #db: DatabaseSync

  constructor(path: string = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS threads (
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        PRIMARY KEY (project_id, thread_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pull_requests (
        repository TEXT NOT NULL,
        number INTEGER NOT NULL CHECK (number > 0),
        commits_observed_at INTEGER,
        PRIMARY KEY (repository, number)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS thread_pr_links (
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('referenced', 'created')),
        source_id TEXT NOT NULL CHECK (length(source_id) > 0),
        PRIMARY KEY (project_id, thread_id, repository, pr_number, kind, source_id),
        FOREIGN KEY (project_id, thread_id) REFERENCES threads ON DELETE CASCADE,
        FOREIGN KEY (repository, pr_number) REFERENCES pull_requests ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS links_by_pr ON thread_pr_links (repository, pr_number);
      CREATE TABLE IF NOT EXISTS pr_commits (
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        PRIMARY KEY (repository, pr_number, sha),
        FOREIGN KEY (repository, pr_number) REFERENCES pull_requests ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS prs_by_commit ON pr_commits (repository, sha);
      CREATE TABLE IF NOT EXISTS commit_provenance (
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL CHECK (length(event_id) > 0),
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL CHECK (length(run_id) > 0),
        repository TEXT NOT NULL,
        sha TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, event_id),
        FOREIGN KEY (project_id, thread_id) REFERENCES threads ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS provenance_by_commit ON commit_provenance (repository, sha);
      CREATE INDEX IF NOT EXISTS provenance_by_thread ON commit_provenance (project_id, thread_id);
    `)
  }

  close(): void {
    this.#db.close()
  }

  registerThread(thread: ThreadRef, title: string): void {
    this.#db
      .prepare(`
      INSERT INTO threads VALUES (?, ?, ?)
      ON CONFLICT (project_id, thread_id) DO UPDATE SET title = excluded.title
    `)
      .run(thread.projectId, thread.threadId, title)
  }

  #ensurePr(pr: PrRef): PrRef {
    const canonical = prRow.parse({ repository: repositoryKey(pr.repository), number: pr.number })
    this.#db
      .prepare('INSERT OR IGNORE INTO pull_requests (repository, number) VALUES (?, ?)')
      .run(canonical.repository, canonical.number)
    return canonical
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Mentions/attachments are referenced; successful PR-create results are created. */
  linkPr(thread: ThreadRef, pr: PrRef, kind: 'referenced' | 'created', sourceId: string): void {
    this.#transaction(() => {
      const ref = this.#ensurePr(pr)
      this.#db
        .prepare(`
        INSERT INTO thread_pr_links VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, thread_id, repository, pr_number, kind, source_id) DO NOTHING
      `)
        .run(thread.projectId, thread.threadId, ref.repository, ref.number, kind, sourceId)
    })
  }

  /** Exact current membership from a complete provider response, never an additive scrape. */
  observePrCommits(pr: PrRef, shas: string[], observedAt: number): void {
    const commits = [...new Set(shas.map(commitSha))]
    this.#transaction(() => {
      const ref = this.#ensurePr(pr)
      const snapshot = snapshotRow.parse(
        this.#db
          .prepare(`
        SELECT commits_observed_at AS observedAt FROM pull_requests WHERE repository = ? AND number = ?
      `)
          .get(ref.repository, ref.number),
      )
      if (snapshot.observedAt !== null && snapshot.observedAt >= observedAt) {
        throw new Error('Commit snapshot must be newer than the stored snapshot')
      }
      this.#db
        .prepare('DELETE FROM pr_commits WHERE repository = ? AND pr_number = ?')
        .run(ref.repository, ref.number)
      const insert = this.#db.prepare('INSERT INTO pr_commits VALUES (?, ?, ?)')
      for (const sha of commits) insert.run(ref.repository, ref.number, sha)
      this.#db
        .prepare(
          'UPDATE pull_requests SET commits_observed_at = ? WHERE repository = ? AND number = ?',
        )
        .run(observedAt, ref.repository, ref.number)
    })
  }

  /**
   * Host-only input: a successful commit-creation event with exact repository/SHA.
   * A mention, matching author, branch, push, checkout, or HEAD change is insufficient.
   */
  recordCommit(
    thread: ThreadRef,
    repository: string,
    sha: string,
    evidence: {
      eventId: string
      runId: string
      observedAt: number
    },
  ): void {
    const values = [
      thread.projectId,
      evidence.eventId,
      thread.threadId,
      evidence.runId,
      repositoryKey(repository),
      commitSha(sha),
      evidence.observedAt,
    ]
    this.#transaction(() => {
      this.#db
        .prepare(`
        INSERT INTO commit_provenance VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, event_id) DO NOTHING
      `)
        .run(...values)
      const stored = this.#db
        .prepare(`
        SELECT project_id, event_id, thread_id, run_id, repository, sha, observed_at
        FROM commit_provenance WHERE project_id = ? AND event_id = ?
      `)
        .get(thread.projectId, evidence.eventId)
      if (!stored || Object.values(stored).some((value, index) => value !== values[index])) {
        throw new Error('Conflicting commit event replay')
      }
    })
  }

  /** Shared read model for the PR view and PR tool, scoped to an authorized project. */
  getPr(pr: PrRef, projectId: string): PrView {
    const repository = repositoryKey(pr.repository)
    const snapshot = this.#db
      .prepare(`
      SELECT commits_observed_at AS observedAt FROM pull_requests WHERE repository = ? AND number = ?
    `)
      .get(repository, pr.number)
    const observedAt = snapshot ? snapshotRow.parse(snapshot).observedAt : null
    const relations = this.#db
      .prepare(`
      SELECT t.project_id AS projectId, t.thread_id AS threadId, t.title, l.kind
      FROM thread_pr_links l JOIN threads t USING (project_id, thread_id)
      WHERE l.repository = ? AND l.pr_number = ? AND t.project_id = ?
      UNION
      SELECT t.project_id, t.thread_id, t.title, 'contributed'
      FROM pr_commits c JOIN commit_provenance e USING (repository, sha)
      JOIN threads t USING (project_id, thread_id)
      WHERE c.repository = ? AND c.pr_number = ? AND t.project_id = ?
      ORDER BY threadId, kind
    `)
      .all(repository, pr.number, projectId, repository, pr.number, projectId)
      .map((row) => relationRow.parse(row))
    const relatedThreads = [...new Set(relations.map((row) => row.threadId))].map((threadId) => ({
      threadId,
      title: relations.find((row) => row.threadId === threadId)?.title ?? '',
      relationships: relations.filter((row) => row.threadId === threadId).map((row) => row.kind),
    }))
    const commits: PrView['commits'] =
      observedAt === null
        ? null
        : this.#db
            .prepare(`
      SELECT sha FROM pr_commits WHERE repository = ? AND pr_number = ? ORDER BY sha
    `)
            .all(repository, pr.number)
            .map((row) => {
              const { sha } = commitRow.parse(row)
              const evidence = this.#db
                .prepare(`
        SELECT t.project_id AS projectId, t.thread_id AS threadId, t.title,
          e.event_id AS eventId, e.run_id AS runId, e.observed_at AS observedAt
        FROM commit_provenance e JOIN threads t USING (project_id, thread_id)
        WHERE e.repository = ? AND e.sha = ? AND e.project_id = ? ORDER BY e.event_id
      `)
                .all(repository, sha, projectId)
                .map((item) => evidenceRow.parse(item))
              return { sha, attribution: evidence.length > 0 ? 'recorded' : 'unknown', evidence }
            })
    return { repository, number: pr.number, relatedThreads, commitsObservedAt: observedAt, commits }
  }

  /** Thread view: explicit PR links plus PRs containing commits recorded by this thread. */
  getThread(thread: ThreadRef): ThreadView | null {
    const stored = this.#db
      .prepare(`
      SELECT project_id AS projectId, thread_id AS threadId, title
      FROM threads WHERE project_id = ? AND thread_id = ?
    `)
      .get(thread.projectId, thread.threadId)
    if (!stored) return null
    const prs = this.#db
      .prepare(`
      SELECT repository, pr_number AS number FROM thread_pr_links WHERE project_id = ? AND thread_id = ?
      UNION
      SELECT c.repository, c.pr_number FROM commit_provenance e
      JOIN pr_commits c USING (repository, sha) WHERE e.project_id = ? AND e.thread_id = ?
      ORDER BY repository, number
    `)
      .all(thread.projectId, thread.threadId, thread.projectId, thread.threadId)
      .map((row) => prRow.parse(row))
    return {
      ...threadRow.parse(stored),
      pullRequests: prs.map((pr) => {
        const view = this.getPr(pr, thread.projectId)
        return {
          ...pr,
          relationships:
            view.relatedThreads.find((item) => item.threadId === thread.threadId)?.relationships ??
            [],
        }
      }),
    }
  }
}
