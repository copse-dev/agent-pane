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
import { AsyncTtlCache } from '../../async-ttl-cache.ts'
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
  const status = new AsyncTtlCache<string, GhCliStatus>({
    ttlMs: TTL.status,
    maxEntries: 1,
  })
  const workspacePrs = new AsyncTtlCache<string, GhPrSummary[]>({
    ttlMs: TTL.workspacePrs,
    maxEntries: 8,
  })
  const myPrs = new AsyncTtlCache<string, GhPrSummary[] | null>({
    ttlMs: TTL.myPrs,
    maxEntries: 8,
  })
  const details = new AsyncTtlCache<string, GhPrDetails | null>({
    ttlMs: TTL.details,
    maxEntries: 64,
  })
  const checks = new AsyncTtlCache<string, GhPrChecksState>({
    ttlMs: TTL.checks,
    maxEntries: 128,
  })
  const diffs = new AsyncTtlCache<string, GhPrFileDiff | null>({
    ttlMs: TTL.diff,
    maxEntries: 128,
  })
  const issuePages = new AsyncTtlCache<string, GhIssuePage>({
    ttlMs: TTL.issues,
    maxEntries: 8,
  })
  const issues = new AsyncTtlCache<string, GhIssueSummary | null>({
    ttlMs: TTL.issue,
    maxEntries: 128,
  })
  const searches = new AsyncTtlCache<string, GhIssueSummary[]>({
    ttlMs: TTL.search,
    maxEntries: 64,
  })

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
    details.invalidate(key)
    checks.invalidate(key)
    diffs.clear()
    workspacePrs.clear()
    myPrs.clear()
  }

  const backend: GitHubBackend = {
    kind: inner.kind,

    getStatus: () => status.get('status', () => inner.getStatus()),

    listMyOpenPrs: (limit) => myPrs.get(`me:${String(limit)}`, () => inner.listMyOpenPrs(limit)),

    listWorkspaceOpenPrs: (limit) =>
      workspacePrs.get(`ws:${String(limit)}`, () => inner.listWorkspaceOpenPrs(limit)),

    getPrDetails: (ref) => details.get(prKey(ref), () => inner.getPrDetails(ref)),

    getPrFileDiff: (ref, path) =>
      diffs.get(`${prKey(ref)}:${path}`, () => inner.getPrFileDiff(ref, path)),

    getPrChecksState: (ref) => checks.get(prKey(ref), () => inner.getPrChecksState(ref)),

    listWorkspaceOpenIssues: (page, pageSize) =>
      issuePages.get(`${String(page)}:${String(pageSize)}`, () =>
        inner.listWorkspaceOpenIssues(page, pageSize),
      ),

    getIssue: (ref) => issues.get(prKey(ref), () => inner.getIssue(ref)),

    searchWorkspaceIssues: (query, limit) =>
      searches.get(`${query}:${String(limit)}`, () => inner.searchWorkspaceIssues(query, limit)),

    async createPr(input) {
      const result = await inner.createPr(input)
      // A brand-new PR has no cached entry to drop, but it does belong in the
      // open-PR lists the panel renders — so those have to be re-read. A failed
      // create changed nothing; keep the lists so a retry loop cannot burn
      // rate budget on refetches.
      if (result.ok) {
        workspacePrs.clear()
        myPrs.clear()
      }
      return result
    },

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
