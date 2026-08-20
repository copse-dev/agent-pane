import { parseGithubPrUrl } from '@shared/git/github-pr-url.ts'
import { resolveGitHubBackend, type PrRef } from './backend/backend.ts'
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
 */

export async function getGhCliStatus(): Promise<GhCliStatus> {
  return resolveGitHubBackend().getStatus()
}

export async function listMyOpenPrs(limit = 30): Promise<GhPrSummary[] | null> {
  return resolveGitHubBackend().listMyOpenPrs(limit)
}

export async function listWorkspaceOpenPrs(limit = 20): Promise<GhPrSummary[]> {
  return resolveGitHubBackend().listWorkspaceOpenPrs(limit)
}

export async function getGhPrDetails(ref: PrRef): Promise<GhPrDetails | null> {
  return resolveGitHubBackend().getPrDetails(ref)
}

export async function getGhPrFileDiff(ref: PrRef, path: string): Promise<GhPrFileDiff | null> {
  return resolveGitHubBackend().getPrFileDiff(ref, path)
}

export async function getGhPrChecksState(ref: PrRef): Promise<GhPrChecksState> {
  return resolveGitHubBackend().getPrChecksState(ref)
}

/** Resolve a PR URL to an owner/repo/number ref (pure; no backend call). */
export function resolveGithubPrRef(url: string): PrRef | null {
  const parsed = parseGithubPrUrl(url)
  if (!parsed) return null
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number }
}
