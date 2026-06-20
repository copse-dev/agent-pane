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
}
