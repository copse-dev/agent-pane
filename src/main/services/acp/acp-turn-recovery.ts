import type { StreamChunk } from '@shared/types'
import { normalizeStopReason } from '@copse/agent/headless-contract.ts'

export type AcpLastMeaningfulEvent = 'text' | 'reasoning' | 'tool' | null

/** Operation id on the machine bubble that shows the injected recovery prompt. */
export const ACP_UNFINISHED_TURN_RECOVERY_OPERATION_ID = 'acp-unfinished-turn-recovery'

export const ACP_UNFINISHED_TURN_RECOVERY_PROMPT = [
  'You ended after tool execution without giving the user a final response.',
  'Continue the task now. Complete any remaining work, then give the user a concise final result.',
  'Do not end on a plan, promise, or description of what you will do next.',
].join(' ')

export const ACP_UNFINISHED_TURN_FALLBACK =
  'The external agent stopped after using its tools without providing a final result. Send “continue” to resume.'

/**
 * What a turn produced, as opposed to what it happened to end on.
 *
 * This check used to read a single "last meaningful event" and treat any
 * `end_turn` landing on a tool as unfinished — explicitly "regardless of earlier
 * prose". That misreads the ordinary shape where an agent writes its answer and
 * *then* runs one closing verification tool, which is how Codex ends a turn with
 * `sandbox_network_audit` and how Claude ends one with a final check. Measured
 * over this workspace's threads it fired on 54 of 63 `claude-acp` turns and 31 of
 * 81 `codex-acp` turns, re-prompting agents that had already answered — the user
 * then reads the same summary twice, or reads {@link ACP_UNFINISHED_TURN_FALLBACK}
 * claiming a completed turn failed.
 *
 * `sawText` is the signal the check actually wants — did the user get prose at
 * all — so it accumulates across the turn instead of being overwritten by the
 * next event.
 */
export interface AcpTurnProgress {
  /** Last meaningful provider event, retained for the turn-outcome record. */
  lastEvent: AcpLastMeaningfulEvent
  /** Non-empty assistant prose arrived at some point during the turn. */
  sawText: boolean
  /** At least one tool call ran during the turn. */
  sawTool: boolean
}

export const EMPTY_ACP_TURN_PROGRESS: AcpTurnProgress = {
  lastEvent: null,
  sawText: false,
  sawTool: false,
}

/** Fold one provider-authored chunk into the turn's progress record. */
export function nextAcpTurnProgress(
  previous: AcpTurnProgress,
  chunk: StreamChunk,
): AcpTurnProgress {
  switch (chunk.type) {
    case 'text':
      return chunk.text.trim() ? { ...previous, lastEvent: 'text', sawText: true } : previous
    case 'reasoning':
      return chunk.text.trim() ? { ...previous, lastEvent: 'reasoning' } : previous
    case 'tool_call':
      return { ...previous, lastEvent: 'tool', sawTool: true }
    // `tool_result` / `tool_call_update` are completion bookkeeping for a call
    // already counted, so they never move the record.
    default:
      return previous
  }
}

/**
 * Recover only a turn that ran tools and produced no prose at all — the single
 * case where the user is left with nothing to read. A turn that answered and
 * then ran one more tool has already given its final response; re-prompting it
 * only makes it repeat itself.
 */
export function shouldRecoverAcpTurn(
  rawStopReason: string | undefined,
  progress: AcpTurnProgress,
): boolean {
  return (
    normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' &&
    progress.sawTool &&
    !progress.sawText
  )
}

/** The recovery worked when it produced the prose the original turn never did. */
export function acpTurnHasFinalResponse(
  rawStopReason: string | undefined,
  progress: AcpTurnProgress,
): boolean {
  return normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' && progress.sawText
}
