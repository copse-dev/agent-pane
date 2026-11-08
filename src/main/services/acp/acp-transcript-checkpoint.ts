import { createHash } from 'node:crypto'
import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'

export interface AcpTranscriptCheckpoint {
  messageCount: number
  prefixHash: string
}

function transcriptHash(messages: readonly LLMMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

/** The prefix delivered to the agent, excluding its not-yet-generated answer. */
export function checkpointAcpTranscript(
  priorMessages: readonly LLMMessage[],
  prompt: UserContent,
): AcpTranscriptCheckpoint {
  const current: LLMMessage = { role: 'user', content: prompt }
  const delivered = [...priorMessages, current]
  return { messageCount: delivered.length, prefixHash: transcriptHash(delivered) }
}

/** Catch up another provider's turns without resending this agent's own answers. */
export function unseenAcpTranscript(
  priorMessages: LLMMessage[],
  checkpoint: AcpTranscriptCheckpoint | undefined,
): LLMMessage[] {
  if (
    !checkpoint ||
    priorMessages.length < checkpoint.messageCount ||
    transcriptHash(priorMessages.slice(0, checkpoint.messageCount)) !== checkpoint.prefixHash
  )
    return priorMessages
  const tail = priorMessages.slice(checkpoint.messageCount)
  const firstUnseenUser = tail.findIndex((message) => message.role === 'user')
  return firstUnseenUser < 0 ? [] : tail.slice(firstUnseenUser)
}
