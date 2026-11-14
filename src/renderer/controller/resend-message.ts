import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { Message, Thread, UserContent } from '@shared/types'
import { addMessage, getThreadById } from '@shared/store/thread-helpers.ts'
import { replayPromptText } from '@shared/threads/prompt-placeholders.ts'
import {
  dispatchAgentRun,
  enqueueUserMessage,
  queuedMessageIds,
  startHumanTurnTree,
} from './message-queue.ts'

/**
 * Resending the last message — submit the thread's most recent user prompt
 * again, without retyping it. Useful after a failed turn, a wrong branch of
 * reasoning, or simply to get a second attempt at the same question.
 *
 * A resend is a **new turn**, not a rewrite of history: the original prompt and
 * everything it produced stay in the transcript, and the prompt is appended
 * again exactly as the composer would append it. That keeps the transcript
 * honest about what was actually sent, and means a resend behaves identically
 * whether the agent is idle (dispatch now) or running (queue behind the turn).
 *
 * Fidelity note: legacy transcript prompts store only visible text, so their
 * attachment placeholders cannot be rebuilt. Protected prompts instead retain
 * canonical provider text and Main-owned projection provenance. Their exact
 * reviewed bytes can be resent from `content` even though the display chip is
 * omitted from the new bubble.
 */

export interface ResendResult {
  /** Id of the newly appended user message. */
  messageId: string
  /** Queued behind a live run rather than dispatched immediately. */
  queued: boolean
  /** The original prompt carried attachment chips omitted from the new bubble. */
  droppedAttachments: boolean
  /** The user explicitly chose the text-only recovery for an image prompt. */
  omittedImages: boolean
}

export interface ResendOptions {
  /** Defaults true. False is the explicit “Resend without image” recovery path. */
  includeImages?: boolean
}

/**
 * The message a resend would repeat: the last **settled** user prompt — one
 * that has already been sent. A queued follow-up is still editable in the
 * pinned queue panel, so it is never what "resend the last message" means.
 */
export function lastResendableMessage(thread: Thread): Message | null {
  const queued = queuedMessageIds(thread)
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]
    if (!message || message.role !== 'user' || queued.has(message.id)) continue
    // A prompt whose only content was chips has nothing left to re-send.
    if (
      !replayPromptText(message.content, message.attachments, message.promptRepresentation) &&
      (message.images?.length ?? 0) === 0
    )
      return null
    return message
  }
  return null
}

function contentOf(text: string, images: readonly string[]): UserContent {
  if (images.length === 0) return text
  return [
    ...images.map((dataUrl) => ({ type: 'image' as const, dataUrl })),
    { type: 'text' as const, text },
  ]
}

/**
 * Re-send a thread's last settled user prompt. Returns `null` when the thread is
 * unknown or has no prompt to repeat.
 */
export function resendLastMessage(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  options: ResendOptions = {},
): ResendResult | null {
  const thread = getThreadById(store, threadId)
  if (!thread) return null
  const original = lastResendableMessage(thread)
  if (!original) return null

  const originalImages = original.images ?? []
  const images = options.includeImages === false ? [] : originalImages
  const text = replayPromptText(
    original.content,
    original.attachments,
    original.promptRepresentation,
  )
  const payload: AgentRunPayload = {
    content: contentOf(text, images),
    invokedSkills: [],
    priorTodos: thread.todos ?? [],
    ...(thread.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
  }

  // The resent bubble carries the prompt and its images, but no attachment
  // chips: the payload above has no inlined attachment blocks, so showing them
  // would claim context the agent never receives.
  const messageId = addMessage(
    store,
    threadId,
    'user',
    text,
    images.length > 0 ? [...images] : undefined,
  )

  const running = thread.status === 'running'
  const queued = { messageId, payload, createdAt: Date.now() }
  if (running) {
    enqueueUserMessage(store, threadId, queued)
  } else {
    // Same contract as a typed prompt at idle (decision 16): a human submission
    // starts a fresh turn tree, so late async hooks from the previous turn are
    // held rather than folded into this one.
    startHumanTurnTree(store, threadId)
    dispatchAgentRun(store, api, threadId, payload, queued)
  }

  return {
    messageId,
    queued: running,
    droppedAttachments: (original.attachments ?? []).length > 0,
    omittedImages: originalImages.length > 0 && images.length === 0,
  }
}
