/**
 * Method-level TTL cache in front of a {@link GitHubBackend}.
 *
 * HTTP ETags (API backend) make revalidation cheap; this layer skips GitHub
 * entirely for a few seconds so every window can share one ~30s list cadence
 * without spending REST or GraphQL budget. Manual refresh clears the slots
 * first. The timer itself lives in `github-list-watch.ts`, not per renderer.
 *
 * `gh` CLI calls share the same user quotas as the API backend — there is no
 * extra CLI allowance — so the wrapper sits in front of both.
 */
import type {
  GhCliStatus,
  GhIssueSummary,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
  PrActionResult,
} from '@shared/types/git.ts'
import type { GhIssuePage, GitHubBackend, PrRef } from './backend.ts'

const TTL = {
  status: 60_000,
  workspacePrs: 20_000,
  myPrs: 45_000,
  details: 15_000,
  checks: 15_000,
  issues: 30_000,
  issue: 60_000,
  search: 20_000,
  diff: 60_000,
} as const

class CacheSlot<T> {
  private entry: { value: T; storedAt: number } | null = null
  private inflight: Promise<T> | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  async get(load: () => Promise<T>): Promise<T> {
    const existing = this.entry
    if (existing && Date.now() - existing.storedAt < this.ttlMs) return existing.value
    if (this.inflight) return this.inflight
    const promise = load().then(
      (value) => {
        this.entry = { value, storedAt: Date.now() }
        this.inflight = null
        return value
      },
      (err: unknown) => {
        this.inflight = null
        throw err
      },
    )
    this.inflight = promise
    return promise
  }

  clear(): void {
    this.entry = null
  }
}

class KeyedCache<T> {
  private readonly slots = new Map<string, CacheSlot<T>>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  slot(key: string): CacheSlot<T> {
    const existing = this.slots.get(key)
    if (existing) return existing
    const created = new CacheSlot<T>(this.ttlMs)
    this.slots.set(key, created)
    return created
  }

  delete(key: string): void {
    this.slots.delete(key)
  }

  clear(): void {
    this.slots.clear()
  }
}

function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`
}

const wrappers: Array<{ clear(): void }> = []

/** Drop every method-level slot. Manual refresh calls this so the next read is live. */
export function invalidateGitHubReadCache(): void {
  for (const wrapper of wrappers) wrapper.clear()
}

export function resetGitHubReadCacheForTest(): void {
  invalidateGitHubReadCache()
}

export function cachingGitHubBackend(inner: GitHubBackend): GitHubBackend {
  const status = new CacheSlot<GhCliStatus>(TTL.status)
  const workspacePrs = new KeyedCache<GhPrSummary[]>(TTL.workspacePrs)
  const myPrs = new KeyedCache<GhPrSummary[] | null>(TTL.myPrs)
  const details = new KeyedCache<GhPrDetails | null>(TTL.details)
  const checks = new KeyedCache<GhPrChecksState>(TTL.checks)
  const diffs = new KeyedCache<GhPrFileDiff | null>(TTL.diff)
  const issuePages = new KeyedCache<GhIssuePage>(TTL.issues)
  const issues = new KeyedCache<GhIssueSummary | null>(TTL.issue)
  const searches = new KeyedCache<GhIssueSummary[]>(TTL.search)

  const handle = {
    clear(): void {
      status.clear()
      workspacePrs.clear()
      myPrs.clear()
      details.clear()
      checks.clear()
      diffs.clear()
      issuePages.clear()
      issues.clear()
      searches.clear()
    },
  }
  wrappers.push(handle)

  function invalidatePr(ref: PrRef): void {
    const key = prKey(ref)
    details.delete(key)
    checks.delete(key)
    diffs.clear()
    workspacePrs.clear()
    myPrs.clear()
  }

  const backend: GitHubBackend = {
    kind: inner.kind,

    getStatus: () => status.get(() => inner.getStatus()),

    listMyOpenPrs: (limit) =>
      myPrs.slot(`me:${String(limit)}`).get(() => inner.listMyOpenPrs(limit)),

    listWorkspaceOpenPrs: (limit) =>
      workspacePrs.slot(`ws:${String(limit)}`).get(() => inner.listWorkspaceOpenPrs(limit)),

    getPrDetails: (ref) => details.slot(prKey(ref)).get(() => inner.getPrDetails(ref)),

    getPrFileDiff: (ref, path) =>
      diffs.slot(`${prKey(ref)}:${path}`).get(() => inner.getPrFileDiff(ref, path)),

    getPrChecksState: (ref) => checks.slot(prKey(ref)).get(() => inner.getPrChecksState(ref)),

    listWorkspaceOpenIssues: (page, pageSize) =>
      issuePages
        .slot(`${String(page)}:${String(pageSize)}`)
        .get(() => inner.listWorkspaceOpenIssues(page, pageSize)),

    getIssue: (ref) => issues.slot(prKey(ref)).get(() => inner.getIssue(ref)),

    searchWorkspaceIssues: (query, limit) =>
      searches
        .slot(`${query}:${String(limit)}`)
        .get(() => inner.searchWorkspaceIssues(query, limit)),

    async rerunFailedRuns(ref) {
      const result = await inner.rerunFailedRuns(ref)
      invalidatePr(ref)
      return result
    },

    async approvePr(ref) {
      const result: PrActionResult = await inner.approvePr(ref)
      invalidatePr(ref)
      return result
    },

    async markPrReady(ref) {
      const result = await inner.markPrReady(ref)
      invalidatePr(ref)
      return result
    },

    async enableAutoMerge(ref) {
      const result = await inner.enableAutoMerge(ref)
      invalidatePr(ref)
      return result
    },
  }
  return backend
}
