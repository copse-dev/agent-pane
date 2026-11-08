import type { Thread } from './types/thread.ts'

export interface ThreadPromptCommand {
  id: string
  sourceThreadId: string
  projectId: string
  thread: Thread
  text: string
  expiresAt: number
  /** Main-authorized child creation requires an isolated checkout before dispatch. */
  requireWorktree?: boolean
  /** The main-owned grant that authorizes this submission. */
  authorizingAccess?: 'orchestrate'
}

export type ThreadPromptResult = { ok: true; queued: boolean } | { ok: false; error: string }
