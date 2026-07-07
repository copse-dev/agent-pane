import type {
  GhCliStatus,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
  PrActionResult,
} from '@shared/types/git.ts'
import type { GitHubBackend, PrRef } from './backend.ts'
import {
  MOCK_GH_PR_NUMBER,
  MOCK_GH_WORKSPACE_PR_NUMBER,
  mockGetGhPrChecksState,
  mockGetGhPrDetails,
  mockGetGhPrFileDiff,
  mockGhCliStatus,
  mockListMyOpenPrs,
  mockListWorkspaceOpenPrs,
} from '../gh-pr-mock.ts'

/**
 * Mutable per-PR state layered on top of the (immutable) mock fixtures so the
 * lifecycle write actions have something to visibly change. Keyed by
 * owner/repo/number (see stateKey).
 */
interface MockPrState {
  autoMergeEnabled: boolean
  reviewDecision?: string
  isDraft: boolean
  failedRuns: number
}

const prState = new Map<string, MockPrState>()

// Match the real backends: state is per owner/repo/number, not per number, so
// same-numbered PRs in different repos don't share draft/approve/auto-merge state.
function stateKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`
}

/**
 * The write-action e2e opts in with `COPSE_PANEL_MOCK_GH_ACTIONS=1` so the
 * linked PR (#42) starts as a draft — letting the spec screenshot a real
 * draft → ready transition — without disturbing the read-only PR-panel spec,
 * which never sets the flag and so sees the unchanged fixtures.
 */
function actionsFixtureEnabled(): boolean {
  return process.env['COPSE_PANEL_MOCK_GH_ACTIONS'] === '1'
}

function initialState(ref: PrRef): MockPrState {
  return {
    autoMergeEnabled: false,
    isDraft: actionsFixtureEnabled() && ref.number === MOCK_GH_PR_NUMBER,
    failedRuns: ref.number === MOCK_GH_WORKSPACE_PR_NUMBER ? 1 : 0,
  }
}

function ensureState(ref: PrRef): MockPrState {
  const key = stateKey(ref)
  let state = prState.get(key)
  if (!state) {
    state = initialState(ref)
    prState.set(key, state)
  }
  return state
}

/** Drop all mutated state; call between unit tests. */
export function resetMockBackendStateForTest(): void {
  prState.clear()
}

/** In-memory backend used under `COPSE_PANEL_MOCK_GH=1` (e2e + unit tests). */
export const mockGitHubBackend: GitHubBackend = {
  kind: 'mock',

  getStatus(): Promise<GhCliStatus> {
    return Promise.resolve(mockGhCliStatus())
  },

  listMyOpenPrs(limit: number): Promise<GhPrSummary[] | null> {
    const status = mockGhCliStatus()
    return Promise.resolve(status.authenticated ? mockListMyOpenPrs().slice(0, limit) : null)
  },

  listWorkspaceOpenPrs(limit: number): Promise<GhPrSummary[]> {
    const status = mockGhCliStatus()
    return Promise.resolve(status.authenticated ? mockListWorkspaceOpenPrs().slice(0, limit) : [])
  },

  getPrDetails(ref: PrRef): Promise<GhPrDetails | null> {
    const base = mockGetGhPrDetails(ref)
    if (!base) return Promise.resolve(null)
    const state = ensureState(ref)
    const details: GhPrDetails = {
      ...base,
      isDraft: state.isDraft,
      autoMergeEnabled: state.autoMergeEnabled,
    }
    if (state.reviewDecision) details.reviewDecision = state.reviewDecision
    return Promise.resolve(details)
  },

  getPrFileDiff(ref: PrRef, path: string): Promise<GhPrFileDiff | null> {
    return Promise.resolve(mockGetGhPrFileDiff(ref, path))
  },

  getPrChecksState(ref: PrRef): Promise<GhPrChecksState> {
    return Promise.resolve(mockGetGhPrChecksState(ref))
  },

  rerunFailedRuns(ref: PrRef): Promise<PrActionResult> {
    const state = ensureState(ref)
    if (state.failedRuns === 0) {
      return Promise.resolve({
        ok: true,
        backend: 'mock',
        noop: true,
        rerunCount: 0,
        message: 'No failed runs to re-run.',
      })
    }
    const count = state.failedRuns
    state.failedRuns = 0
    return Promise.resolve({
      ok: true,
      backend: 'mock',
      rerunCount: count,
      message: `Re-ran ${String(count)} failed run${count === 1 ? '' : 's'} on the PR branch.`,
    })
  },

  approvePr(ref: PrRef): Promise<PrActionResult> {
    ensureState(ref).reviewDecision = 'APPROVED'
    return Promise.resolve({
      ok: true,
      backend: 'mock',
      message: `Approved PR #${String(ref.number)}.`,
    })
  },

  markPrReady(ref: PrRef): Promise<PrActionResult> {
    const state = ensureState(ref)
    if (!state.isDraft) {
      return Promise.resolve({
        ok: true,
        backend: 'mock',
        noop: true,
        message: `PR #${String(ref.number)} is already ready for review.`,
      })
    }
    state.isDraft = false
    return Promise.resolve({
      ok: true,
      backend: 'mock',
      message: `Marked PR #${String(ref.number)} ready for review.`,
    })
  },

  enableAutoMerge(ref: PrRef): Promise<PrActionResult> {
    const state = ensureState(ref)
    if (state.autoMergeEnabled) {
      return Promise.resolve({
        ok: true,
        backend: 'mock',
        noop: true,
        strategy: 'squash',
        message: `Auto-merge already enabled for #${String(ref.number)}.`,
      })
    }
    state.autoMergeEnabled = true
    return Promise.resolve({
      ok: true,
      backend: 'mock',
      strategy: 'squash',
      message: `Enabled auto-merge (squash) for #${String(ref.number)}.`,
    })
  },
}
