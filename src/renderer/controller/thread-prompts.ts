import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadPromptCommand, ThreadPromptResult } from '@shared/thread-prompt.ts'
import type { MachineMessageOrigin } from '@shared/types/thread.ts'
import {
  addMessage,
  applyPreparedThreadCheckout,
  getThreadById,
  patchThreadAnywhere,
} from '@shared/store/thread-helpers.ts'
import { beginThreadSubmission, endThreadSubmission } from '@shared/store/pending-submissions.ts'
import { deleteQueuedMessage, drainMessageQueue, enqueueUserMessage } from './message-queue.ts'
import { backgroundProjectOf } from './background-threads.ts'
import { flushPendingThreadPersistence } from './persistence.ts'

export async function acceptThreadPrompt(
  store: AppStore,
  api: ApiClient,
  command: ThreadPromptCommand,
): Promise<ThreadPromptResult> {
  const threadId = command.thread.id
  if (Date.now() >= command.expiresAt || command.sourceThreadId === threadId)
    return { ok: false, error: 'This prompt expired or targets its own thread.' }
  if (!beginThreadSubmission(store, threadId))
    return {
      ok: false,
      error: 'Another prompt is being submitted to this thread. Try again shortly.',
    }
  try {
    const state = store.getState()
    const resident = getThreadById(store, threadId)
    if (
      resident &&
      (backgroundProjectOf(store, threadId) ?? state.activeProjectId) !== command.projectId
    )
      return { ok: false, error: 'The destination project changed.' }
    if (!resident) {
      if (state.activeProjectId === command.projectId)
        store.setState({ threads: [...state.threads, command.thread] })
      else
        store.setState({
          backgroundThreads: [
            ...state.backgroundThreads,
            { projectId: command.projectId, thread: command.thread },
          ],
        })
    } else if (resident.messagesLoaded === false) {
      // Main supplies a fresh full transcript. Keep any locally streamed tail
      // while hydrating a sidebar-only destination, including other projects.
      const diskIds = new Set(command.thread.messages.map((message) => message.id))
      patchThreadAnywhere(store, threadId, (thread) => ({
        ...thread,
        messages: [
          ...command.thread.messages,
          ...thread.messages.filter((message) => !diskIds.has(message.id)),
        ],
        messagesLoaded: command.thread.messagesLoaded !== false,
      }))
    }
    let current = getThreadById(store, threadId)
    if (
      !current ||
      current.archivedAt !== undefined ||
      current.messagesLoaded === false ||
      Date.now() >= command.expiresAt
    )
      return { ok: false, error: 'The destination conversation is unavailable.' }
    if (
      (!current.worktreeChoice && current.messages.length === 0) ||
      (command.requireWorktree && (!current.worktree || current.worktree.retiredAt !== undefined))
    ) {
      // No base branch, so main starts the worktree from the fetched default
      // branch. A subthread deliberately does not inherit its parent's
      // branch: it is an independent thread with its own branch and PR, and a
      // parent's unpublished worktree branch would leave the child's PR stacked
      // on work that may never merge. Work that must build on the parent's
      // branch belongs in an isolated worker (`isolated-worker-checkout.ts`),
      // which cuts from the parent's branch and reports back within the
      // parent's own turn.
      const prepared = await api.agent.prepareCheckout(
        command.projectId,
        threadId,
        command.text,
        command.requireWorktree ? 'worktree' : 'automatic',
        current.model,
      )
      if (Date.now() >= command.expiresAt)
        return { ok: false, error: 'This prompt expired while preparing the checkout.' }
      if (command.requireWorktree && prepared.checkoutMode !== 'worktree')
        return { ok: false, error: 'Subthreads require an isolated checkout.' }
      applyPreparedThreadCheckout(store, threadId, prepared)
      current = getThreadById(store, threadId)
      if (!current || current.archivedAt !== undefined)
        return { ok: false, error: 'The destination conversation is unavailable.' }
    }
    if (!(await api.threadPrompts.canSubmit(command.id)))
      return {
        ok: false,
        error: 'The prompt was cancelled, expired, or its permission was revoked.',
      }
    current = getThreadById(store, threadId)
    if (!current || current.archivedAt !== undefined || Date.now() >= command.expiresAt)
      return { ok: false, error: 'The destination conversation is unavailable.' }
    // Delegated subthread prompts keep the continuation budget; only peer
    // prompts carry main's per-destination allowance scope.
    const peerTurnTreeId = command.authorizingAccess ? undefined : command.sourceTurnTreeId
    const peerScope = command.authorizingAccess ? undefined : command.crossThreadScope
    const origin: MachineMessageOrigin = {
      kind: 'machine',
      operationId: `${command.authorizingAccess ? 'subthread' : 'thread'}:${command.sourceThreadId}`,
      ...(peerScope === undefined ? {} : { crossThreadScope: peerScope }),
    }
    // A never-used destination inherits the existing sender root instead of
    // minting a fresh epoch on every machine run. Subsequent incoming prompts
    // cannot replenish its own outgoing allowance or self-continuation budget.
    if (current.currentEpoch === undefined && peerTurnTreeId !== undefined)
      patchThreadAnywhere(store, threadId, (thread) => ({
        ...thread,
        currentEpoch: peerTurnTreeId,
      }))
    // An earlier failed run does not prevent an authorized new prompt.
    if (current.status === 'error')
      patchThreadAnywhere(store, threadId, (thread) => ({ ...thread, status: 'idle' }))
    const messageId = addMessage(store, threadId, 'user', command.text, undefined, undefined, {
      origin,
    })
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: command.text },
      createdAt: Date.now(),
      origin,
      ...(command.unattended === true ? { threadPromptGrantId: command.id } : {}),
    })
    if (command.unattended === true) {
      await flushPendingThreadPersistence()
      const activation = await api.threadPrompts.activateGrant(command.id, messageId)
      if (activation === 'rejected') {
        await deleteQueuedMessage(store, api, threadId, messageId)
        return {
          ok: false,
          error: 'The isolated subthread prompt could not be activated safely.',
        }
      }
    }
    const queued = current.status === 'running' || current.queuePaused === true
    drainMessageQueue(store, api, threadId)
    const accepted = getThreadById(store, threadId)
    if (accepted) {
      try {
        await api.threads.updateMeta(command.projectId, threadId, {
          pendingMessages: accepted.pendingMessages ?? [],
          continuationUsed: accepted.continuationUsed ?? 0,
          crossThreadPromptsUsed: accepted.crossThreadPromptsUsed ?? 0,
          crossThreadPromptCounts: accepted.crossThreadPromptCounts ?? {},
          ...(accepted.currentEpoch !== undefined ? { currentEpoch: accepted.currentEpoch } : {}),
          updatedAt: accepted.updatedAt,
        })
      } catch (error) {
        // The prompt is already queued or running. Reporting rejection would
        // invite a retry that submits it again; retain acceptance and diagnose
        // the persistence failure separately.
        console.error('[threads] could not persist accepted prompt metadata', error)
      }
    }
    return {
      ok: true,
      queued:
        queued ||
        (getThreadById(store, threadId)?.pendingMessages?.some(
          (item) => item.messageId === messageId,
        ) ??
          false),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not submit the prompt.',
    }
  } finally {
    endThreadSubmission(store, threadId)
  }
}
