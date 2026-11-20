import { resolveGitHubBackend, type PrCreateInput, type PrRef } from './backend/backend.ts'
import type { PrActionResult, PrCreateResult } from '@shared/types/git.ts'

/**
 * Wave 1 PR lifecycle write actions, each delegating to the resolved
 * {@link GitHubBackend}. Shared by the `gh:*` IPC handlers (PR-pane buttons)
 * and the PR agent tools. These mutate GitHub state, so — unlike the read
 * facade in `gh-pr-service.ts` — they are kept out of the read-only tool
 * allow-list and their IPC handlers assert a main-frame sender.
 */

export async function createPullRequest(
  root: string | null,
  input: PrCreateInput,
): Promise<PrCreateResult> {
  return resolveGitHubBackend().createPr(root, input)
}

export async function rerunFailedPrRuns(root: string | null, ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().rerunFailedRuns(root, ref)
}

export async function approvePr(root: string | null, ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().approvePr(root, ref)
}

export async function markPrReady(root: string | null, ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().markPrReady(root, ref)
}

export async function enablePrAutoMerge(root: string | null, ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().enableAutoMerge(root, ref)
}
