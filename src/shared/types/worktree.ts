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

/**
 * The thread a linked checkout was allocated for, as far as the chat store
 * still knows. `linked` distinguishes a checkout the thread still points at
 * from one it has already let go of (thread deleted, or metadata cleared after
 * an earlier removal), which is what makes a worktree safe to reclaim.
 */
export interface WorktreeUsage {
  threadId: string
  title: string
  /** Last write to the thread — the closest thing to "when this was last used". */
  updatedAt: number
  archived: boolean
  linked: boolean
  /** An agent turn is running in this thread right now; removal is refused. */
  running: boolean
}

/**
 * One linked checkout of the project's repository, as listed in
 * Settings → Sources → Worktrees. Size is deliberately absent: measuring a
 * checkout walks its whole tree, so it is a separate on-demand call
 * (`worktrees:size`) that fills in after the list has rendered.
 */
export interface WorktreeInventoryEntry {
  /** Canonical top level of the linked checkout. */
  path: string
  branch: string | null
  /** Branch the checkout was based on, when its thread metadata still records it. */
  baseBranch: string | null
  head: string | null
  detached: boolean
  locked: string | null
  prunable: string | null
  /** Allocated by Copse under its worktrees root (vs. created outside the app). */
  managed: boolean
  usage: WorktreeUsage | null
  createdAt: number | null
  /** Most recent thread write or Git activity seen for this checkout. */
  lastUsedAt: number | null
  /** Uncommitted or ignored-file entries; null when the checkout could not be inspected. */
  changedCount: number | null
  /** Branch already contained by its base branch; null when that is unknown. */
  merged: boolean | null
}

/** On-disk footprint of one checkout. `truncated` means the walk hit its entry budget. */
export interface WorktreeSizeResult {
  path: string
  bytes: number
  fileCount: number
  truncated: boolean
}

/**
 * Outcome of removing one linked checkout. Blocking results are values rather
 * than errors: each one is a state the UI shows and offers a next step for.
 */
export type WorktreeRemovalResult =
  | { status: 'removed'; path: string; branch: string | null; branchDeleted: boolean }
  | { status: 'blocked-dirty'; path: string; changed: string[] }
  | { status: 'blocked-running'; path: string; threadId: string }
