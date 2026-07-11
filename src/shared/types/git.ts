export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface GitChange {
  path: string
  status: GitChangeStatus
}

export interface GitStatusResult {
  staged: GitChange[]
  unstaged: GitChange[]
}

export interface GitFileDiff {
  path: string
  before: string
  after: string
  language: string
  /** Data URL for the pre-change image, when the file is an image. */
  beforeImage?: string | null
  /** Data URL for the post-change image, when the file is an image. */
  afterImage?: string | null
}

/**
 * A restore point for the user's pre-agent worktree. `ref` names a
 * `refs/copse/backups/*` commit capturing every uncommitted change (tracked and
 * untracked) as it was before Copse began applying edits over it. Surfaced to
 * the renderer so the git-changes pane can offer a one-click restore.
 */
export interface SessionBackup {
  ref: string
  /** Epoch millis when the snapshot was taken. */
  createdAt: number
  /** Workspace-relative paths that were dirty when the backup was taken. */
  paths: string[]
}

export interface GitOpenPr {
  number: number
  title: string
  url: string
}

/** Checked-out branch plus optional open PR (for HEAD or a named branch). */
export interface GitBranchStatus {
  currentBranch: string | null
  pr: GitOpenPr | null
}

/** Fallback when the repository has no configured default branch name. */
export const DEFAULT_GIT_BRANCH = 'main'

/** Lightweight branch listing: name + most recent commit timestamp. */
export interface GitBranchInfo {
  name: string
  /** ISO-8601 timestamp of the most recent commit on this branch. */
  lastCommitDate: string
}

export interface GhCliStatus {
  installed: boolean
  authenticated: boolean
  username: string | null
  message: string | null
}

/** Overall CI rollup for a PR head, mirroring github-ci-service's CiOverallState. */
export type GhPrChecksState = 'pending' | 'success' | 'failure' | 'no_checks'

export interface GhPrSummary {
  owner: string
  repo: string
  number: number
  title: string
  url: string
  state: string
  headRefName?: string
  authorLogin?: string
  createdAt?: string
  updatedAt?: string
  /** Overall CI state, when known from the listing query (else fetched lazily). */
  checks?: GhPrChecksState
}

export interface GhPrDetails extends GhPrSummary {
  body: string
  baseRefName?: string
  mergeable?: string
  mergeStateStatus?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  files: GhPrChangedFile[]
  /** True while the PR is a draft (mark-ready targets this). */
  isDraft?: boolean
  /** True once merge-when-ready / auto-merge has been enabled. */
  autoMergeEnabled?: boolean
  /** GitHub review decision, e.g. `APPROVED`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`. */
  reviewDecision?: string
}

/** Which backend implementation serviced a GitHub operation. */
export type GitHubBackendKind = 'cli' | 'api' | 'mock'

/** User preference for how the PR panel talks to GitHub. */
export type GitHubBackendPreference = 'auto' | 'cli' | 'api'

/**
 * Result of a PR lifecycle write action (rerun CI, approve, mark-ready,
 * enable-merge-when-ready). Shared by the main-process backends, the IPC
 * surface, the agent tools, and the PR pane so all four speak one shape.
 */
export interface PrActionResult {
  ok: boolean
  /** Human-readable summary shown in the PR pane and returned by agent tools. */
  message: string
  /** Which backend serviced the action (diagnostics + tests). */
  backend: GitHubBackendKind
  /** The action left state unchanged because it already held (idempotent no-op). */
  noop?: boolean
  /** Auto-merge strategy chosen from the repo's allowed merge methods. */
  strategy?: 'squash' | 'merge' | 'rebase'
  /** Number of failed workflow runs that were re-run. */
  rerunCount?: number
}

export interface GhPrChangedFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
}

export interface GhPrFileDiff {
  path: string
  before: string
  after: string
  language: string
  /** The file was deleted in this PR (no `after` content). */
  deleted?: boolean
}
