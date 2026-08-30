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

/**
 * Last line that is a promise of work, not a result. "Let me know if you want
 * more" is a closer, not a plan — the negative lookahead keeps it out.
 */
const ACP_PLAN_SHAPED_LAST_LINE =
  /^(?:let me (?!know\b)|i(?:['’]ll| will| am going to|['’]m going to)|next i\b|now i(?:['’]ll| will)\b)/i

/** True for chunks the host injected into the stream, not the agent. */
export function isAcpHostAuthoredChunk(chunk: StreamChunk): boolean {
  return chunk.host === true
}

/**
 * Non-empty agent prose that is not a trailing plan/promise. Used so a complete
 * answer followed by a last-step tool (lint, format) is not treated as abandoned.
 * Empty text and plan-shaped last lines stay unfinished.
 */
export function acpTextLooksLikeFinalResponse(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  const lastLine =
    trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? ''
  if (/(?:\.{3}|…)\s*$/.test(lastLine)) return false
  return !ACP_PLAN_SHAPED_LAST_LINE.test(lastLine)
}

/**
 * Track only provider-authored events that say whether a turn ended after
 * tools. Host-injected chunks (audit cards, fallback banners) are skipped so
 * they cannot overwrite the agent's last real event.
 */
export function nextAcpMeaningfulEvent(
  previous: AcpLastMeaningfulEvent,
  chunk: StreamChunk,
): AcpLastMeaningfulEvent {
  if (isAcpHostAuthoredChunk(chunk)) return previous
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

/**
 * A normal ACP stop directly after tools is incomplete unless the agent already
 * produced a final-looking answer (the lint-fix case: prose, then a last tool).
 */
export function shouldRecoverAcpTurn(
  rawStopReason: string | undefined,
  lastEvent: AcpLastMeaningfulEvent,
  agentText = '',
): boolean {
  return (
    normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' &&
    lastEvent === 'tool' &&
    !acpTextLooksLikeFinalResponse(agentText)
  )
}

/**
 * The recovery succeeded when it ended normally with final prose — either as
 * the last streamed event, or as earlier text followed by a last-step tool.
 */
export function acpTurnHasFinalResponse(
  rawStopReason: string | undefined,
  lastEvent: AcpLastMeaningfulEvent,
  agentText = '',
): boolean {
  return (
    normalizeStopReason(rawStopReason?.toLowerCase()) === 'end_turn' &&
    (lastEvent === 'text' || acpTextLooksLikeFinalResponse(agentText))
  )
}
