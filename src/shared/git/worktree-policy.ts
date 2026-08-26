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
      reason: 'not-local' | 'not-git' | 'detached-head' | 'submodules-unsupported'
      seededFromDirtyProject: false
    }

function unsupportedReason(
  input: WorktreePolicyInput,
): Extract<WorktreePolicyDecision, { checkoutMode: 'blocked' }>['reason'] | null {
  if (!input.isLocal) return 'not-local'
  if (!input.isGitRepository) return 'not-git'
  if (input.hasSubmodules) return 'submodules-unsupported'
  if (!input.currentBranch) return 'detached-head'
  return null
}

/**
 * The `checkoutMode` `decideThreadWorktreePolicy` will reach without
 * inspecting the repository, or null when the repository genuinely decides.
 *
 * An explicit shared choice always settles to `shared`. An automatic choice
 * also settles to `shared` when the project has worktrees disabled. With no
 * project mode, use the policy's default (`always`), which still requires the
 * repository inspection because an unsupported repository falls back to the
 * shared checkout.
 *
 * Callers that only need the mode — such as the composer's checkout preview,
 * which the footer re-runs on every thread switch — can use this to skip four
 * Git queries, including `getDefaultBranch`'s possible network fallback.
 *
 * `worktree-policy.test.ts` pins the agreement exhaustively: wherever this
 * returns a mode, `decideThreadWorktreePolicy` must return the same one for
 * every combination of inspection inputs.
 */
export function settledCheckoutMode(
  input: Pick<WorktreePolicyInput, 'choice' | 'projectMode'>,
): WorktreePolicyDecision['checkoutMode'] | null {
  const choice = input.choice ?? 'automatic'
  const projectMode = input.projectMode ?? DEFAULT_PROJECT_WORKTREE_MODE
  if (choice === 'shared') return 'shared'
  if (choice === 'automatic' && projectMode === 'never') return 'shared'
  return null
}

/**
 * Whether the project's uncommitted work can be carried into the new worktree.
 *
 * Seeding restores a snapshot of the selected local checkout over the new
 * worktree. The allocator performs the final commit check: when a selected
 * default branch has moved upstream, it starts clean rather than applying the
 * snapshot to that newer tree.
 */
function canSeedFromDirtyProject(input: WorktreePolicyInput): boolean {
  return input.isDirty && input.currentBranch !== null
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
