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
 *
 * Every slot is keyed by the checkout that asked as well as the arguments: the
 * "workspace" reads name a different repository per root, and a read with no
 * root (which the CLI backend refuses) must not be served to one that has a
 * root (#3958).
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
import { branchPrCache } from '../branch-pr-cache.ts'
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

/** Slot key for `root`; the NUL separator cannot occur in a path. */
function rootKey(root: string | null, rest: string): string {
  return `${root ?? ''}\u0000${rest}`
}

const wrappers: Array<{ clear(): void }> = []

/** Drop every method-level slot. Manual refresh calls this so the next read is live. */
export function invalidateGitHubReadCache(): void {
  branchPrCache.invalidate()
  for (const wrapper of wrappers) wrapper.clear()
}

export function resetGitHubReadCacheForTest(): void {
  invalidateGitHubReadCache()
}

export function cachingGitHubBackend(inner: GitHubBackend): GitHubBackend {
  const status = new AsyncTtlCache<string, GhCliStatus>({
    ttlMs: TTL.status,
    maxEntries: 8,
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

  // The PR's slots exist once per root that read it, so drop them all; writes
  // are rare enough that clearing the whole slot is cheaper than indexing it.
  function invalidatePr(): void {
    details.clear()
    checks.clear()
    diffs.clear()
    workspacePrs.clear()
    myPrs.clear()
  }

  const backend: GitHubBackend = {
    kind: inner.kind,

    getStatus: (root) => status.get(rootKey(root, 'status'), () => inner.getStatus(root)),

    listMyOpenPrs: (root, limit) =>
      myPrs.get(rootKey(root, `me:${String(limit)}`), () => inner.listMyOpenPrs(root, limit)),

    listWorkspaceOpenPrs: (root, limit) =>
      workspacePrs.get(rootKey(root, `ws:${String(limit)}`), () =>
        inner.listWorkspaceOpenPrs(root, limit),
      ),

    getPrDetails: (root, ref) =>
      details.get(rootKey(root, prKey(ref)), () => inner.getPrDetails(root, ref)),

    getPrFileDiff: (root, ref, path) =>
      diffs.get(rootKey(root, `${prKey(ref)}:${path}`), () => inner.getPrFileDiff(root, ref, path)),

    getPrChecksState: (root, ref) =>
      checks.get(rootKey(root, prKey(ref)), () => inner.getPrChecksState(root, ref)),

    listWorkspaceOpenIssues: (root, page, pageSize) =>
      issuePages.get(rootKey(root, `${String(page)}:${String(pageSize)}`), () =>
        inner.listWorkspaceOpenIssues(root, page, pageSize),
      ),

    getIssue: (root, ref) => issues.get(rootKey(root, prKey(ref)), () => inner.getIssue(root, ref)),

    searchWorkspaceIssues: (root, query, limit) =>
      searches.get(rootKey(root, `${query}:${String(limit)}`), () =>
        inner.searchWorkspaceIssues(root, query, limit),
      ),

    async createPr(root, input) {
      const result = await inner.createPr(root, input)
      // A brand-new PR has no cached entry to drop, but it does belong in the
      // open-PR lists the panel renders — so those have to be re-read. A failed
      // create changed nothing; keep the lists so a retry loop cannot burn
      // rate budget on refetches.
      if (result.ok) {
        branchPrCache.invalidate()
        workspacePrs.clear()
        myPrs.clear()
      }
      return result
    },

    async rerunFailedRuns(root, ref) {
      const result = await inner.rerunFailedRuns(root, ref)
      if (result.ok) branchPrCache.invalidate()
      invalidatePr()
      return result
    },

    async approvePr(root, ref) {
      const result: PrActionResult = await inner.approvePr(root, ref)
      if (result.ok) branchPrCache.invalidate()
      invalidatePr()
      return result
    },

    async markPrReady(root, ref) {
      const result = await inner.markPrReady(root, ref)
      if (result.ok) branchPrCache.invalidate()
      invalidatePr()
      return result
    },

    async enableAutoMerge(root, ref) {
      const result = await inner.enableAutoMerge(root, ref)
      if (result.ok) branchPrCache.invalidate()
      invalidatePr()
      return result
    },
  }
  return backend
}
