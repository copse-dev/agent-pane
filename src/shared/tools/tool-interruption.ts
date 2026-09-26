import type { ToolCall } from '@shared/types'

/**
 * Host-written result for ACP calls still in flight when a turn is cancelled.
 * The next model must not read an unverified call as completed, or assume it
 * did nothing: a tool can have produced effects before its output was lost.
 */
export const ACP_CANCELLED_TOOL_CALL_RESULT =
  'Interrupted before completion — no final output was received. This tool may have partially run or produced effects; inspect the current state before retrying it.'

export function isHostInterruptedToolCall(toolCall: ToolCall): boolean {
  return toolCall.status === 'error' && toolCall.result === ACP_CANCELLED_TOOL_CALL_RESULT
}
