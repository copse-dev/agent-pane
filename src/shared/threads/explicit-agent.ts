import type { Message } from '@shared/types'
import { isRecord } from '@copse/std/unknown-value.ts'

/**
 * An explicit native invocation owns one synthetic task card. The transcript
 * can split that card and its final report into separate assistant messages,
 * so inspect the current user turn rather than only the final message.
 */
export function explicitAgentForMessage(
  messages: readonly Message[],
  messageIndex: number,
): string | undefined {
  if (messages[messageIndex]?.role !== 'assistant') return undefined
  let agent: string | undefined
  for (let index = messageIndex; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role === 'user') break
    for (const call of message.toolCalls) {
      if (
        agent !== undefined ||
        call.name !== 'task' ||
        // ACP can use the same name; its title/kind/identity metadata belongs
        // to the external parent, not a host-synthesized explicit invocation.
        call.title !== undefined ||
        call.kind !== undefined ||
        call.programmaticName !== undefined ||
        !isRecord(call.args) ||
        typeof call.args['subagent_type'] !== 'string' ||
        call.args['subagent_type'].length === 0
      ) {
        return undefined
      }
      agent = call.args['subagent_type']
    }
  }
  return agent
}
