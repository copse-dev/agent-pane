import type { ProjectWorktreeMode, ThreadWorktreeChoice } from '@shared/types/worktree.ts'

/**
 * Threads are isolated unless a project opts out. Every caller that resolves a
 * project's mode reads this, so the default lives in exactly one place.
 */
export const DEFAULT_PROJECT_WORKTREE_MODE: ProjectWorktreeMode = 'always'

export type WorktreePolicyReason =
  | 'explicit-shared'
  | 'explicit-worktree'
  | 'project-always'
  | 'project-disabled'
  | 'not-local'
  | 'not-git'
  | 'default-branch-unresolved'
  | 'detached-head'
  | 'submodules-unsupported'

export interface WorktreePolicyInput {
  choice?: ThreadWorktreeChoice
  projectMode?: ProjectWorktreeMode
  isLocal: boolean
  isGitRepository: boolean
  currentBranch: string | null
  defaultBranch: string | null
  isDirty: boolean
  hasSubmodules: boolean
}

export type WorktreePolicyDecision =
  | {
      checkoutMode: 'worktree'
      reason: 'explicit-worktree' | 'project-always'
      seededFromDirtyProject: boolean
    }
  | {
      checkoutMode: 'shared'
      reason: Exclude<WorktreePolicyReason, 'explicit-worktree' | 'project-always'>
      seededFromDirtyProject: false
    }
  | {
      checkoutMode: 'blocked'
      reason:
        | 'not-local'
        | 'not-git'
        | 'default-branch-unresolved'
        | 'detached-head'
        | 'submodules-unsupported'
      seededFromDirtyProject: false
    }

function unsupportedReason(
  input: WorktreePolicyInput,
): Extract<WorktreePolicyDecision, { checkoutMode: 'blocked' }>['reason'] | null {
  if (!input.isLocal) return 'not-local'
  if (!input.isGitRepository) return 'not-git'
  if (input.hasSubmodules) return 'submodules-unsupported'
  if (!input.currentBranch) return 'detached-head'
  if (!input.defaultBranch) return 'default-branch-unresolved'
  return null
}

/**
 * Whether the project's uncommitted work can be carried into the new worktree.
 *
 * Seeding restores a snapshot of the project checkout over the worktree
 * wholesale, so it only describes the same state when both start from the same
 * branch. A worktree is always cut from the default branch; when the project
 * checkout is on some other branch, those edits were made against a different
 * tree and restoring them would silently merge two unrelated states. In that
 * case the thread starts clean and the user's own checkout is left untouched.
 */
function canSeedFromDirtyProject(input: WorktreePolicyInput): boolean {
  if (!input.isDirty) return false
  return input.currentBranch !== null && input.currentBranch === input.defaultBranch
}

/** Decide the first-message checkout without inspecting mutable process state. */
export function decideThreadWorktreePolicy(input: WorktreePolicyInput): WorktreePolicyDecision {
  const choice = input.choice ?? 'automatic'
  const projectMode = input.projectMode ?? DEFAULT_PROJECT_WORKTREE_MODE

  if (choice === 'shared') {
    return { checkoutMode: 'shared', reason: 'explicit-shared', seededFromDirtyProject: false }
  }

  const unsupported = unsupportedReason(input)
  if (unsupported) {
    return choice === 'worktree'
      ? { checkoutMode: 'blocked', reason: unsupported, seededFromDirtyProject: false }
      : { checkoutMode: 'shared', reason: unsupported, seededFromDirtyProject: false }
  }

  if (choice === 'worktree') {
    return {
      checkoutMode: 'worktree',
      reason: 'explicit-worktree',
      seededFromDirtyProject: canSeedFromDirtyProject(input),
    }
  }

  if (projectMode === 'never') {
    return { checkoutMode: 'shared', reason: 'project-disabled', seededFromDirtyProject: false }
  }
  // The project checkout's own branch no longer steers this. A worktree is cut
  // from the default branch either way, so isolating only while the user
  // happened to be on that branch just meant the second thread of a session
  // inherited the first thread's branch and working tree.
  return {
    checkoutMode: 'worktree',
    reason: 'project-always',
    seededFromDirtyProject: canSeedFromDirtyProject(input),
  }
}

function slugPrompt(prompt: string): string {
  const slug = prompt
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
    .replace(/-+$/g, '')
  return slug || 'thread'
}

function shortThreadId(threadId: string): string {
  const compact = threadId.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (compact.slice(-6) || 'thread').slice(0, 6)
}

/** Stable branch candidate; `collision` is incremented only when Git reports a conflict. */
export function threadWorktreeBranchName(prompt: string, threadId: string, collision = 0): string {
  const base = `copse/${slugPrompt(prompt)}-${shortThreadId(threadId)}`
  return collision > 0 ? `${base}-${String(collision + 1)}` : base
}
