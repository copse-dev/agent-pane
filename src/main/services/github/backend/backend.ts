import type {
  GhCliStatus,
  GhIssueSummary,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
  GitHubBackendPreference,
  PrActionResult,
} from '@shared/types/git.ts'
import { getSetting } from '../../storage/settings.ts'
import { isGhAvailable } from '../../tool-availability.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
  isSshWorkspaceExecutionEnabled,
} from '../../ssh-workspace/execution-target.ts'
import { isMockGhEnabled } from '../gh-pr-mock.ts'
import { hasGitHubApiToken } from './github-token.ts'
import { ghCliBackend } from './gh-cli-backend.ts'
import { githubApiBackend } from './github-api-backend.ts'
import { mockGitHubBackend } from './mock-backend.ts'

/** A pull request addressed by repo + number, the unit every action operates on. */
export interface PrRef {
  owner: string
  repo: string
  number: number
}

/**
 * A swappable GitHub backend for the PR panel and the PR agent tools.
 *
 * The same interface is implemented three ways — the `gh` CLI, the GitHub REST
 * + GraphQL API, and an in-memory mock — so the panel (and anything else that
 * needs PR reads or lifecycle writes) can be pointed at whichever is available
 * without knowing which one it got. Reads mirror the shapes in
 * `@shared/types/git.ts`; writes return a uniform {@link PrActionResult}.
 */
export interface GitHubBackend {
  readonly kind: 'cli' | 'api' | 'mock'

  // Reads — back the PR panel.
  getStatus(): Promise<GhCliStatus>
  listMyOpenPrs(limit: number): Promise<GhPrSummary[] | null>
  listWorkspaceOpenPrs(limit: number): Promise<GhPrSummary[]>
  getPrDetails(ref: PrRef): Promise<GhPrDetails | null>
  getPrFileDiff(ref: PrRef, path: string): Promise<GhPrFileDiff | null>
  getPrChecksState(ref: PrRef): Promise<GhPrChecksState>
  /** Open issues in the workspace repo (PRs excluded) — backs roadmap import. */
  listWorkspaceOpenIssues(limit: number): Promise<GhIssueSummary[]>
  /** One issue by coordinates (any state); null when missing or actually a PR. */
  getIssue(ref: PrRef): Promise<GhIssueSummary | null>

  // Writes — Wave 1 PR lifecycle actions.
  rerunFailedRuns(ref: PrRef): Promise<PrActionResult>
  approvePr(ref: PrRef): Promise<PrActionResult>
  markPrReady(ref: PrRef): Promise<PrActionResult>
  enableAutoMerge(ref: PrRef): Promise<PrActionResult>
}

/** Settings key controlling which backend the PR panel talks to. */
export const GITHUB_BACKEND_SETTING = 'githubBackend'

/**
 * Env override for the backend, checked before the setting. Lets tests and
 * power users force `cli` / `api` without touching persisted settings.
 */
function backendEnvOverride(): GitHubBackendPreference | null {
  const raw = process.env['COPSE_PANEL_GITHUB_BACKEND']?.trim().toLowerCase()
  if (raw === 'cli' || raw === 'api' || raw === 'auto') return raw
  return null
}

/**
 * Pure backend-selection decision, factored out so it is unit-testable without
 * touching settings/env/gh probes. `auto` prefers the CLI when `gh` is present
 * (it carries the user's existing `gh auth login`), and falls back to the API
 * only when a token is available; otherwise it stays on the CLI so its status
 * can report the "install / sign in" guidance.
 */
export function decideBackendKind(opts: {
  preference: GitHubBackendPreference
  ghAvailable: boolean
  hasApiToken: boolean
  /** When true, prefer the HTTPS API backend (remote host may lack gh). */
  sshWorkspace?: boolean
}): 'cli' | 'api' {
  if (opts.preference === 'cli') return 'cli'
  if (opts.preference === 'api') return 'api'
  if (opts.sshWorkspace && opts.hasApiToken) return 'api'
  if (opts.ghAvailable) return 'cli'
  return opts.hasApiToken ? 'api' : 'cli'
}

/** Resolve the backend that should service GitHub reads/writes right now. */
export function resolveGitHubBackend(): GitHubBackend {
  // The mock stands in for both real backends under e2e / unit tests, gated by
  // the same env var the read services already honor.
  if (isMockGhEnabled()) return mockGitHubBackend
  const preference =
    backendEnvOverride() ?? getSetting<GitHubBackendPreference>(GITHUB_BACKEND_SETTING, 'auto')
  const target = getActiveExecutionTarget()
  const sshWorkspace = isSshWorkspaceExecutionEnabled() && isSshExecutionTarget(target)
  const kind = decideBackendKind({
    preference,
    ghAvailable: isGhAvailable(),
    hasApiToken: hasGitHubApiToken(),
    sshWorkspace,
  })
  return kind === 'api' ? githubApiBackend : ghCliBackend
}
