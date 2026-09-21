import type { AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import { addMessage } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { commitThreadModelSelection } from './model-selection.ts'
import { dispatchAgentRun, startHumanTurnTree } from './message-queue.ts'

export const INTERRUPTED_TURN_CONTINUATION =
  'Continue the interrupted turn from the persisted history. Do not repeat completed tool calls. Inspect the current state before taking further action, then finish the request.'

export type FailedTurnRecoveryMode = 'current-model' | 'last-known-good'

export interface FailedTurnRecovery {
  /** A route that completed an earlier turn. It may no longer be available now. */
  lastKnownGoodModel?: string
}

/**
 * Describe the explicit recovery still available for one exact failed message.
 *
 * Recovery belongs only to the transcript tail. A later message or queued
 * follow-up means the user has already moved the conversation on, and an
 * unloaded transcript cannot prove either condition. Both settled thread
 * states are eligible: most runs land on `idle`, while transport/startup
 * failures can leave the thread in `error`.
 */
export function turnRecoveryForMessage(
  thread: Thread | undefined,
  failedMessageId: string,
): FailedTurnRecovery | null {
  if (!thread || thread.messagesLoaded === false) return null
  if (thread.status !== 'idle' && thread.status !== 'error') return null
  if ((thread.pendingMessages?.length ?? 0) > 0) return null

  const failedIndex = thread.messages.length - 1
  const failed = thread.messages[failedIndex]
  if (
    !failed ||
    failed.id !== failedMessageId ||
    failed.role !== 'assistant' ||
    failed.turnOutcome?.status !== 'failed'
  ) {
    return null
  }

  if (failed.turnOutcome.source !== 'provider') return {}
  for (let index = failedIndex - 1; index >= 0; index -= 1) {
    const candidate = thread.messages[index]
    if (candidate?.role === 'assistant' && candidate.turnOutcome?.status === 'completed') {
      // Legacy completed turns can lack route attribution. They prove success,
      // but cannot name a fallback, so keep looking for the latest usable one.
      if (candidate.model === undefined) continue
      return candidate.model !== failed.turnOutcome.model
        ? { lastKnownGoodModel: candidate.model }
        : {}
    }
  }
  return {}
}

/**
 * Start a human-authorized continuation after an interrupted turn.
 *
 * The fixed prompt deliberately continues from the checkpointed transcript; it
 * does not duplicate the original instruction or replay any tool call. All
 * ownership and tail checks are repeated at click time so a detached/stale card
 * cannot dispatch into a newly selected project or thread.
 */
export function recoverFailedTurn(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
  failedMessageId: string,
  mode: FailedTurnRecoveryMode,
): boolean {
  const state = store.getState()
  if (
    state.activeProjectId !== projectId ||
    state.activeThreadId !== threadId ||
    !state.threads.some((thread) => thread.id === threadId)
  ) {
    return false
  }

  const thread = state.threads.find((candidate) => candidate.id === threadId)
  const recovery = turnRecoveryForMessage(thread, failedMessageId)
  if (!thread || !recovery) return false

  if (mode === 'last-known-good') {
    const fallback = recovery.lastKnownGoodModel
    if (fallback === undefined) return false
    commitThreadModelSelection(store, api, threadId, 'user', thread.model, fallback)
  }

  const payload: AgentRunPayload = {
    content: INTERRUPTED_TURN_CONTINUATION,
    invokedSkills: [],
    priorTodos: thread.todos ?? [],
    ...(thread.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
  }
  addMessage(store, threadId, 'user', INTERRUPTED_TURN_CONTINUATION)
  startHumanTurnTree(store, threadId)
  dispatchAgentRun(store, api, threadId, payload)
  return true
}
