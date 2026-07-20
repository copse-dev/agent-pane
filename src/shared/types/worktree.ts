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

export type ThreadCheckoutMode = 'shared' | 'worktree'

/** Non-mutating policy result shown before the first message is sent. */
export interface ThreadCheckoutPreview {
  checkoutMode: ThreadCheckoutMode | 'blocked'
}

/** Main-process result of the first-message checkout transaction. */
export interface PreparedThreadCheckout {
  checkoutMode: ThreadCheckoutMode
  choice: ThreadWorktreeChoice
  branch: string | null
  worktree?: ThreadWorktree
}
