import type { ThreadWorktree } from '@shared/types/worktree.ts'

export type ThreadArchiveResult =
  | { status: 'archived'; archivedAt: number; worktree?: ThreadWorktree | undefined }
  | { status: 'blocked-dirty'; paths: string[] }
  | { status: 'blocked-running' }
