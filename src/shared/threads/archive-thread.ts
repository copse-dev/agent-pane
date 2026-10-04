import type { ThreadWorktree } from '@shared/types/worktree.ts'

export type ThreadArchiveResult =
  | { status: 'archived'; archivedAt: number; worktree?: ThreadWorktree | undefined }
  | { status: 'blocked-dirty'; paths: string[]; fingerprint: string }
  | { status: 'blocked-running' }
