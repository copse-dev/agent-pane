import type { ThreadWorktree } from '@shared/types/worktree.ts'

/** What is still alive for a thread; archiving stops these only once the user agrees. */
export interface ThreadLiveResources {
  agent: boolean
  terminals: boolean
  backgroundProcesses: boolean
  /**
   * A thread-owned isolated desktop VM, which outlives turns and mounts no host
   * folders. Optional so older hosts stay compatible; this host always sets it.
   */
  isolatedDesktop?: boolean
}

export type ThreadArchiveResult =
  | { status: 'archived'; archivedAt: number; worktree?: ThreadWorktree | undefined }
  | { status: 'blocked-dirty'; paths: string[]; fingerprint: string }
  | { status: 'blocked-running'; running: ThreadLiveResources }
