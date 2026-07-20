export type ThreadWorktreeChoice = 'automatic' | 'shared' | 'worktree'

export type ProjectWorktreeMode = 'from-default-branch' | 'always' | 'never'

/** Durable metadata for a linked checkout owned by one thread. */
export interface ThreadWorktree {
  /** Diagnostic only; main reconstructs and validates the authoritative path. */
  path: string
  branch: string
  baseBranch: string
  baseCommit: string
  createdAt: number
  seededFromDirtyProject: boolean
}
