import { parseGithubPrUrl } from '@shared/git/github-pr-url.ts'
import { resolveGitHubBackend, type PrRef } from './backend/backend.ts'
import { invalidateGitHubReadCache } from './backend/github-read-cache.ts'
import type {
  GhCliStatus,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
} from '@shared/types/git.ts'

/**
 * PR-panel data facade. Every read here delegates to the resolved
 * {@link GitHubBackend} (gh CLI, REST/GraphQL API, or the in-memory mock), so
 * callers — the IPC handlers, the agent tools, the renderer — never care which
 * backend serviced the request. The adapter lives in `./backend/`.
 *
 * `root` is the asker's checkout (see {@link GitHubBackend}).
 */

export async function getGhCliStatus(root: string | null): Promise<GhCliStatus> {
  return resolveGitHubBackend().getStatus(root)
}

export async function listMyOpenPrs(
  root: string | null,
  limit = 30,
): Promise<GhPrSummary[] | null> {
  return resolveGitHubBackend().listMyOpenPrs(root, limit)
}

export async function listWorkspaceOpenPrs(
  root: string | null,
  limit = 20,
): Promise<GhPrSummary[]> {
  return resolveGitHubBackend().listWorkspaceOpenPrs(root, limit)
}

export async function getGhPrDetails(root: string | null, ref: PrRef): Promise<GhPrDetails | null> {
  return resolveGitHubBackend().getPrDetails(root, ref)
}

export async function getGhPrFileDiff(
  root: string | null,
  ref: PrRef,
  path: string,
): Promise<GhPrFileDiff | null> {
  return resolveGitHubBackend().getPrFileDiff(root, ref, path)
}

export async function getGhPrChecksState(
  root: string | null,
  ref: PrRef,
): Promise<GhPrChecksState> {
  return resolveGitHubBackend().getPrChecksState(root, ref)
}

/** Drop TTL'd GitHub reads so the next list/details fetch is live (manual refresh). */
export function invalidateGithubReadCache(): void {
  invalidateGitHubReadCache()
}

/** Resolve a PR URL to an owner/repo/number ref (pure; no backend call). */
export function resolveGithubPrRef(url: string): PrRef | null {
  const parsed = parseGithubPrUrl(url)
  if (!parsed) return null
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number }
}
