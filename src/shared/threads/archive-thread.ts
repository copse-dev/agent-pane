import type { ThreadWorktree } from '@shared/types/worktree.ts'

/** What is still alive for a thread; archiving stops these only once the user agrees. */
export interface ThreadLiveResources {
  agent: boolean
  terminals: boolean
  backgroundProcesses: boolean
}

export type ThreadArchiveResult =
  | { status: 'archived'; archivedAt: number; worktree?: ThreadWorktree | undefined }
  | { status: 'blocked-dirty'; paths: string[]; fingerprint: string }
  | { status: 'blocked-running'; running: ThreadLiveResources }
