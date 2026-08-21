import type { StreamChunk } from '@shared/types'
import { normalizeStopReason } from '@copse/agent/headless-contract.ts'

export type AcpLastMeaningfulEvent = 'text' | 'reasoning' | 'tool' | null

export const ACP_UNFINISHED_TURN_RECOVERY_PROMPT = [
  'You ended after tool execution without giving the user a final response.',
  'Continue the task now. Complete any remaining work, then give the user a concise final result.',
  'Do not end on a plan, promise, or description of what you will do next.',
].join(' ')

export const ACP_UNFINISHED_TURN_FALLBACK =
  'The external agent stopped after using its tools without providing a final result. Send “continue” to resume.'

/** Track only provider-authored events that say whether a turn ended after tools. */
export function nextAcpMeaningfulEvent(
  previous: AcpLastMeaningfulEvent,
  chunk: StreamChunk,
): AcpLastMeaningfulEvent {
  switch (chunk.type) {
    case 'text':
      return chunk.text.trim() ? 'text' : previous
    case 'reasoning':
      return chunk.text.trim() ? 'reasoning' : previous
    case 'tool_call':
    case 'tool_result':
    case 'tool_call_update':
      return 'tool'
    default:
      return previous
  }
}

/** A normal ACP stop directly after tools is incomplete regardless of earlier prose. */
export function shouldRecoverAcpTurn(
  rawStopReason: string | undefined,
  lastEvent: AcpLastMeaningfulEvent,
): boolean {
  return normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' && lastEvent === 'tool'
}

/** The recovery only succeeded when it itself ended normally with final prose. */
export function acpTurnHasFinalResponse(
  rawStopReason: string | undefined,
  lastEvent: AcpLastMeaningfulEvent,
): boolean {
  return normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' && lastEvent === 'text'
}
