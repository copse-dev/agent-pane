import { errorMessage } from './errors.ts'
import type { Thread } from './types/thread.ts'

export interface ThreadPromptCommand {
  id: string
  sourceThreadId: string
  /**
   * The sender's user turn tree, when the sending run has one. A never-used
   * destination inherits it as its epoch. A delegated subthread prompt
   * (`authorizingAccess`) has none and stays on the destination's continuation
   * budget.
   */
  sourceTurnTreeId?: string
  /**
   * Main's per-destination allowance scope for a peer prompt
   * (`send_thread_prompt`): JSON `[sourceThreadId, sourceTurnTreeId]`, with
   * `null` for a run that has no user turn (see `peerPromptSender`). Absent on
   * delegated subthread prompts.
   */
  crossThreadScope?: string
  projectId: string
  thread: Thread
  text: string
  expiresAt: number
  /** Main-authorized child creation requires an isolated checkout before dispatch. */
  requireWorktree?: boolean
  /** The main-owned grant that authorizes this submission. */
  authorizingAccess?: 'orchestrate'
  /** Only a freshly created owned child may run its exact first prompt unattended. */
  unattended?: true
}

export type ThreadPromptResult = { ok: true; queued: boolean } | { ok: false; error: string }

/**
 * Marks an `agent.run` as a parent's delegated prompt to a subthread it owns, so
 * main rechecks the parent's authority as it dispatches the run.
 */
export interface SubthreadRunDelegation {
  parentThreadId: string
  /** Opaque one-use authority minted with Main's exact child command. */
  promptGrantId?: string
}

/**
 * Name of the rejection main gives a delegated `agent.run` whose parent no longer
 * owns the child or holds orchestration. Electron carries only an invoke
 * rejection's text over IPC, so the renderer recognises it by this name, as it
 * does `AgentTurnBusyError`.
 */
export const SUBTHREAD_PROMPT_HELD_ERROR_NAME = 'SubthreadPromptHeldError'

export class SubthreadPromptHeldError extends Error {
  override readonly name = SUBTHREAD_PROMPT_HELD_ERROR_NAME

  constructor(threadId: string) {
    super(
      `Held the delegated prompt for thread "${threadId}": its parent no longer owns it or holds orchestration`,
    )
  }
}

/** Whether `reason` is main holding a delegated prompt, in-process or across IPC. */
export function isSubthreadPromptHeldError(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === SUBTHREAD_PROMPT_HELD_ERROR_NAME) return true
  return errorMessage(reason).includes(`${SUBTHREAD_PROMPT_HELD_ERROR_NAME}:`)
}
