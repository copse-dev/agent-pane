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
