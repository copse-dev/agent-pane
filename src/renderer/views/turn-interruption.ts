import type { Message, TurnOutcome } from '@shared/types'

/** Whose action cut a turn short: an explicit Stop, or a new prompt sent mid-run. */
export type InterruptionCause = 'message' | 'user'

/**
 * Why a user-cancelled turn ended. `next` is the message that follows the
 * turn's last bubble; a prompt queued mid-run is adjacent too, so the renderer
 * that aborted the run records how in `userAbort`.
 */
export function interruptionCause(
  outcome: TurnOutcome,
  next: Message | undefined,
): InterruptionCause {
  if (next?.role !== 'user' || next.origin !== undefined) return 'user'
  // The renderer that aborted the run recorded how: a prompt queued mid-run and
  // drained after an explicit Stop is adjacent too, and must not be blamed.
  if (outcome.userAbort !== undefined) return outcome.userAbort === 'send_now' ? 'message' : 'user'
  // Turns recorded before `userAbort`: send-now queues the human bubble before
  // the abort settles, while a prompt sent after a Stop has a later timestamp.
  return next.createdAt <= outcome.endedAt ? 'message' : 'user'
}

/** The user-visible phrasing of an interruption. */
export function interruptionNote(cause: InterruptionCause): string {
  return cause === 'message' ? 'Interrupted when you sent a new message.' : 'Interrupted by you.'
}
