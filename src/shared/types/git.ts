export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface GitChange {
  path: string
  status: GitChangeStatus
  /**
   * A wholly-untracked directory that `git status` collapsed into a single
   * `?? dir/` record instead of listing its files. `path` carries no trailing
   * slash.
   */
  isDirectory?: boolean
}

export interface GitStatusResult {
  staged: GitChange[]
  unstaged: GitChange[]
}

/**
 * Files changed by commits that have not reached a pull request yet: the
 * `<base>...HEAD` diff, where `base` is the branch's remote head when an open PR
 * already carries those commits, and the merge-base with the default branch
 * otherwise. Committing does not remove work from the Changes panel; it moves
 * the work into this section.
 */
export interface GitCommittedChanges {
  /** What HEAD was compared against, for display: `main`, `origin/feature-x`. */
  baseLabel: string
  changes: GitChange[]
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
  /**
   * Present when `path` is an untracked directory: the untracked files inside
   * it, capped for IPC (a fresh node_modules holds tens of thousands). The
   * viewer renders these as a file list instead of a text diff.
   */
  directoryFiles?: string[]
  /** Total untracked files in the directory; may exceed `directoryFiles.length`. */
  directoryFileCount?: number
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

/** Repository snapshot captured at a prompt boundary (issue: spine prompt hash / dirty state). */
export interface GitPromptState {
  /** Full HEAD commit SHA the prompt was sent against, or null outside a repo / no commits yet. */
  startingCommit: string | null
  /** Whether the working tree had staged or unstaged changes at send time. */
  dirty: boolean
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

/** An issue in the workspace repo, as listed for roadmap import or review. */
export interface GhIssueSummary {
  owner: string
  repo: string
  number: number
  title: string
  url: string
  /** Issue body (truncated by the backend); used to draft a roadmap prompt. */
  body: string
  labels: string[]
  updatedAt?: string
  /** Present when the backend knows lifecycle state (open listings default to open). */
  state?: 'open' | 'closed'
}

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

/**
 * Result of opening a pull request. Carries the created PR's coordinates on
 * success so callers never have to scrape them back out of `message` — that
 * URL is what links the PR to the thread that opened it.
 */
export interface PrCreateResult extends PrActionResult {
  /** Full `https://github.com/owner/repo/pull/N` URL of the new PR. */
  url?: string
  number?: number
}

/**
 * What a caller asks for when opening a pull request, before any of it has been
 * resolved: only the title is required, and everything else is inferred from
 * the thread's checkout (see `createPrForThread`). Distinct from
 * `PrCreateInput`, which is the fully-resolved argument set handed to a backend.
 *
 * Shared rather than main-only because both entry points name it — the
 * `gh_pr_create` tool's parameters and the "Create PR" dialog's IPC payload.
 */
export interface PrCreateRequest {
  title: string
  /** Body markdown. The attribution trailer is appended downstream, not here. */
  body?: string | undefined
  /** Branch to merge into. Omit for the repository's default branch. */
  base?: string | undefined
  /** Branch holding the changes. Omit for the checkout's current branch. Must be pushed. */
  head?: string | undefined
  draft?: boolean | undefined
  owner?: string | undefined
  repo?: string | undefined
}

export interface GhPrChangedFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
}

export interface GhPrFileDiff extends GitFileDiff {
  /** The file was deleted in this PR (no `after` content). */
  deleted?: boolean
}
