const MAX_PENDING_RECEIPTS = 4096
const pending = new Set<string>()

function key(senderId: number, projectId: string, threadId: string, messageId: string): string {
  return `${String(senderId)}\0${projectId}\0${threadId}\0${messageId}`
}

/** Record a brand-new renderer append as eligible for one protected reconciliation. */
export function recordProtectedPromptMessageAppend(
  senderId: number,
  projectId: string,
  threadId: string,
  messageId: string,
): void {
  const receipt = key(senderId, projectId, threadId, messageId)
  pending.delete(receipt)
  pending.add(receipt)
  while (pending.size > MAX_PENDING_RECEIPTS) {
    const oldest = pending.values().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

/** A create-with-message earns proof only when it really created one fresh first prompt. */
export function recordProtectedPromptThreadCreate(
  senderId: number,
  projectId: string,
  threadId: string,
  created: boolean,
  messages: readonly Pick<Message, 'id' | 'role'>[],
): void {
  const firstPrompt = messages.length === 1 ? messages[0] : undefined
  if (created && firstPrompt?.role === 'user') {
    recordProtectedPromptMessageAppend(senderId, projectId, threadId, firstPrompt.id)
  }
}

/** Main-owned proof that this window appended the still-unsent optimistic message. */
export function hasProtectedPromptMessageAppend(
  senderId: number,
  projectId: string,
  threadId: string,
  messageId: string,
): boolean {
  return pending.has(key(senderId, projectId, threadId, messageId))
}

/** Consume the proof only after protected review accepts the prompt. */
export function consumeProtectedPromptMessageAppend(
  senderId: number,
  projectId: string,
  threadId: string,
  messageId: string,
): boolean {
  return pending.delete(key(senderId, projectId, threadId, messageId))
}
import type { Message } from '@shared/types'
