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
