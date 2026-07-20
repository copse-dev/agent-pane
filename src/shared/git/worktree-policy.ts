import type { ProjectWorktreeMode, ThreadWorktreeChoice } from '@shared/types/worktree.ts'

export type WorktreePolicyReason =
  | 'explicit-shared'
  | 'explicit-worktree'
  | 'project-always'
  | 'default-branch'
  | 'project-disabled'
  | 'non-default-branch'
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
      reason: 'explicit-worktree' | 'project-always' | 'default-branch'
      seededFromDirtyProject: boolean
    }
  | {
      checkoutMode: 'shared'
      reason: Exclude<
        WorktreePolicyReason,
        'explicit-worktree' | 'project-always' | 'default-branch'
      >
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

/** Decide the first-message checkout without inspecting mutable process state. */
export function decideThreadWorktreePolicy(input: WorktreePolicyInput): WorktreePolicyDecision {
  const choice = input.choice ?? 'automatic'
  const projectMode = input.projectMode ?? 'never'

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
      seededFromDirtyProject: input.isDirty,
    }
  }

  if (projectMode === 'never') {
    return { checkoutMode: 'shared', reason: 'project-disabled', seededFromDirtyProject: false }
  }
  if (projectMode === 'always') {
    return {
      checkoutMode: 'worktree',
      reason: 'project-always',
      seededFromDirtyProject: input.isDirty,
    }
  }
  if (input.currentBranch === input.defaultBranch) {
    return {
      checkoutMode: 'worktree',
      reason: 'default-branch',
      seededFromDirtyProject: input.isDirty,
    }
  }
  return { checkoutMode: 'shared', reason: 'non-default-branch', seededFromDirtyProject: false }
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
