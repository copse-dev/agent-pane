import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { addMessage, getThreadById, setReviewerInputAnswer } from '@shared/store/thread-helpers.ts'
import { reviewerInputAnswer, reviewerInputRequests } from '@shared/threads/reviewer-input.ts'
import { drainMessageQueue, enqueueUserMessage, startHumanTurnTree } from './message-queue.ts'

/**
 * Treat an answer as a normal human follow-up. It waits behind an active turn
 * and drains at idle, so answering never interrupts the independent work the
 * agent is doing. The transcript message and metadata use the same request id.
 */
export function answerReviewerInput(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  requestId: string,
  answer: string,
): boolean {
  const text = answer.trim()
  const thread = getThreadById(store, threadId)
  if (!thread || text === '' || text.length > 8192) return false
  const request = reviewerInputRequests(thread).find((item) => item.id === requestId)
  if (!request || reviewerInputAnswer(thread.reviewerInputAnswers, requestId)) return false
  const content = `Answer to your review question “${request.question}”: ${text}`
  // Match an ordinary typed prompt: an answer submitted at idle starts a new
  // human turn tree, while one queued behind an active run stays in that tree.
  // Resetting the epoch here while a run is still finishing would make its
  // continuation-budget fold-back look stale and discard it.
  if (thread.status === 'idle') startHumanTurnTree(store, threadId)
  const messageId = addMessage(store, threadId, 'user', content)
  setReviewerInputAnswer(store, threadId, {
    id: requestId,
    text,
    answeredAt: Date.now(),
    messageId,
  })
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content },
    createdAt: Date.now(),
  })
  drainMessageQueue(store, api, threadId)
  return true
}
