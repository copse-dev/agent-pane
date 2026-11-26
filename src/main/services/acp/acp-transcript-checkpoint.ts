import { sha256Hex } from '@copse/std/sha256.ts'
import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'

export interface AcpTranscriptCheckpoint {
  messageCount: number
  prefixHash: string
}

function transcriptHash(messages: readonly LLMMessage[]): string {
  return sha256Hex(JSON.stringify(messages))
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

/** A checkpoint for history the agent already holds in full, such as an imported session's. */
export function checkpointAcpHistory(delivered: readonly LLMMessage[]): AcpTranscriptCheckpoint {
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
