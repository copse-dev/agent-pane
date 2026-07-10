import { resolveGitHubBackend, type PrRef } from './backend/backend.ts'
import type { PrActionResult } from '@shared/types/git.ts'

/**
 * Wave 1 PR lifecycle write actions, each delegating to the resolved
 * {@link GitHubBackend}. Shared by the `gh:*` IPC handlers (PR-pane buttons)
 * and the PR agent tools. These mutate GitHub state, so — unlike the read
 * facade in `gh-pr-service.ts` — they are kept out of the read-only tool
 * allow-list and their IPC handlers assert a main-frame sender.
 */

export async function rerunFailedPrRuns(ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().rerunFailedRuns(ref)
}

export async function approvePr(ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().approvePr(ref)
}

export async function markPrReady(ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().markPrReady(ref)
}

export async function enablePrAutoMerge(ref: PrRef): Promise<PrActionResult> {
  return resolveGitHubBackend().enableAutoMerge(ref)
}
