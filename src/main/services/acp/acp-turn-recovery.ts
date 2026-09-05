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
 * Result written onto a tool call the turn ended on top of (#2332). `ToolCall`
 * has no `cancelled` status, so this reuses `error` and says so in the payload.
 *
 * The text matters as much as the status: the transcript is what the *next*
 * turn's model reads. An interrupted call left `running` renders as a spinner
 * that never stops, and one the agent stamps `completed` — some emit a terminal
 * `tool_call_update` carrying the call's own description where its output should
 * be — reads as a command that ran and printed nothing. Both invite the model to
 * build on an outcome the host cannot actually know.
 */
export const ACP_CANCELLED_TOOL_CALL_RESULT =
  'Interrupted before completion — no final output was received. This tool may have partially run or produced effects; inspect the current state before retrying it.'

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

/**
 * Whether a chunk opens a tool call or settles one, so the turn can know which
 * calls were still in flight if it ends early (#2332). `null` for everything
 * else. A `tool_call_update` only settles on a terminal status — ACP agents
 * stream progress through the same chunk.
 */
export function acpToolCallLifecycle(
  chunk: StreamChunk,
): { toolCallId: string; state: 'open' | 'settled' } | null {
  switch (chunk.type) {
    case 'tool_call':
      return { toolCallId: chunk.toolCall.id, state: 'open' }
    case 'tool_result':
      return { toolCallId: chunk.toolCallId, state: 'settled' }
    case 'tool_call_update':
      return chunk.status === 'done' || chunk.status === 'error'
        ? { toolCallId: chunk.toolCallId, state: 'settled' }
        : null
    default:
      return null
  }
}

/** A host-authored `tool_call_update`, the only chunk the tracker emits. */
type ToolCallUpdateChunk = Extract<StreamChunk, { type: 'tool_call_update' }>

/**
 * Tracks which of a turn's tool calls are in flight so an interrupted turn can
 * settle them itself (#2332 defect 2).
 *
 * Settling has to happen at the *abort* site, not once the turn has unwound: the
 * agent goes on streaming for as long as its own wind-down takes, and in the
 * reported trace it stamped the killed call `done` 235ms after the cancel, with
 * the call's own description where its output should be. So `settle()` also takes
 * ownership of those ids — every later chunk for one is refused, leaving the
 * host's verdict as the last word in the transcript the next turn reads.
 */
export function createAcpToolCallTracker(): {
  /**
   * Fold a streamed chunk in. `false` means drop it: it is wind-down noise for a
   * call the host has already cancelled, so it is neither renderable nor
   * progress. Chunks that are not part of a tool call always pass.
   */
  observe: (chunk: StreamChunk) => boolean
  /** Cancel every call still in flight, returning the chunks to emit for them. */
  settle: () => ToolCallUpdateChunk[]
} {
  const open = new Set<string>()
  const hostSettled = new Set<string>()
  return {
    observe(chunk): boolean {
      const lifecycle = acpToolCallLifecycle(chunk)
      if (!lifecycle) return true
      if (hostSettled.has(lifecycle.toolCallId)) return false
      if (lifecycle.state === 'open') open.add(lifecycle.toolCallId)
      else open.delete(lifecycle.toolCallId)
      return true
    },
    settle(): ToolCallUpdateChunk[] {
      const cancelled = [...open].map((toolCallId): ToolCallUpdateChunk => ({
        type: 'tool_call_update',
        toolCallId,
        status: 'error',
        result: ACP_CANCELLED_TOOL_CALL_RESULT,
      }))
      for (const toolCallId of open) hostSettled.add(toolCallId)
      open.clear()
      return cancelled
    },
  }
}

/**
 * The host's own verdict on a turn whose abort the agent honoured cleanly
 * (#2332 defect 4).
 *
 * A well-behaved ACP agent answers `session/cancel` with `stopReason:
 * "cancelled"` and nothing throws, so the turn lands on the *success* path and
 * is recorded `source: 'provider'` — leaving nothing in the transcript to
 * separate "the host killed this on its own deadline" from "the user pressed
 * Stop". The provider's word is still kept as `rawStopReason`; this is the
 * host's. `null` when the turn was not aborted, so the normal path decides.
 */
export function acpAbortedTurnOutcome(
  signal: AbortSignal,
  timedOut: boolean,
): {
  status: 'failed' | 'cancelled'
  stopReason: 'timeout' | 'cancelled'
  source: 'host' | 'user'
} | null {
  if (timedOut) return { status: 'failed', stopReason: 'timeout', source: 'host' }
  if (signal.aborted) return { status: 'cancelled', stopReason: 'cancelled', source: 'user' }
  return null
}
