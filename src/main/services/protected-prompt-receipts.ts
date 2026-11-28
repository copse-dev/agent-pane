const MAX_PENDING_RECEIPTS = 4096

interface ProtectedPromptReceipt {
  senderId: number
  projectId: string
  threadId: string
  messageId: string
}

const pending = new Map<string, ProtectedPromptReceipt>()

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
  const receiptKey = key(senderId, projectId, threadId, messageId)
  pending.delete(receiptKey)
  pending.set(receiptKey, { senderId, projectId, threadId, messageId })
  while (pending.size > MAX_PENDING_RECEIPTS) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

/** Retiring an unsent identity revokes every sender's display reconciliation proof. */
export function revokeProtectedPromptMessageAppends(
  projectId: string,
  threadId: string,
  messageId: string,
): void {
  for (const [receiptKey, receipt] of pending) {
    if (
      receipt.projectId === projectId &&
      receipt.threadId === threadId &&
      receipt.messageId === messageId
    ) {
      pending.delete(receiptKey)
    }
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
