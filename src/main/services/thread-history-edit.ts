import { createHash } from 'node:crypto'
import type { LLMMessage, Message, Thread } from '@shared/types'
import type {
  ThreadHistoryEditRequest,
  ThreadHistoryEditResult,
  ThreadHistorySnapshot,
} from '@shared/threads/history-edit.ts'
import { disposeAcpSession } from './acp/acp-session-pool.ts'
import { rebuildAgentHistory } from './thread-fork.ts'
import {
  agentHistoryExists,
  clearAcpSessionBinding,
  clearAgentHistory,
  clearAgentTurnEpoch,
  clearThreadHistoryUndo,
  commitThreadHistoryMutation,
  finishThreadHistoryUndo,
  getProjectThread,
  loadAgentHistory,
  loadThreadHistoryUndo,
  recoverThreadHistoryMutation,
  saveAgentHistory,
  saveProjectThread,
  stageThreadHistoryMutation,
  type ThreadHistoryStateSnapshot,
} from './thread-store.ts'

export interface ThreadHistoryEditRuntime {
  begin: (projectId: string, threadId: string) => boolean
  end: (projectId: string, threadId: string) => void
  forgetAgentHistory: (projectId: string, threadId: string) => void
}

export function threadHistoryRevision(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages), 'utf8').digest('hex')
}

function messageBlockedReason(message: Message): string | undefined {
  if ((message.attachments?.length ?? 0) > 0) {
    return 'This thread contains file or thread references whose expanded model context is not stored in the transcript.'
  }
  if (message.content.includes('\uFFFC')) {
    return 'This thread contains pasted text whose expanded model context is not stored in the transcript.'
  }
  if ((message.contentBlocks?.length ?? 0) > 0) {
    return 'This thread contains non-text agent content that cannot yet be reconstructed safely.'
  }
  return undefined
}

function blockedReason(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    const reason = messageBlockedReason(message)
    if (reason !== undefined) return reason
  }
  return undefined
}

async function snapshotOf(projectId: string, thread: Thread): Promise<ThreadHistorySnapshot> {
  const revision = threadHistoryRevision(thread.messages)
  const undo = await loadThreadHistoryUndo(projectId, thread.id)
  if (undo && undo.resultingRevision !== revision)
    await clearThreadHistoryUndo(projectId, thread.id)
  const blocked = blockedReason(thread.messages)
  return {
    revision,
    title: thread.title,
    messages: thread.messages.map((message) => {
      const warning = messageBlockedReason(message)
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        included: true,
        hasToolCalls: message.toolCalls.length > 0,
        ...(warning !== undefined ? { reconstructionWarning: warning } : {}),
      }
    }),
    canUndo: undo?.resultingRevision === revision,
    ...(blocked !== undefined ? { blockedReason: blocked } : {}),
  }
}

async function requireThread(projectId: string, threadId: string): Promise<Thread> {
  const thread = await getProjectThread(projectId, threadId)
  if (!thread) throw new Error(`Thread "${threadId}" does not belong to project "${projectId}"`)
  return thread
}

export async function loadThreadHistorySnapshot(
  projectId: string,
  threadId: string,
): Promise<ThreadHistorySnapshot> {
  return await snapshotOf(projectId, await requireThread(projectId, threadId))
}

function validateRequest(
  thread: Thread,
  request: ThreadHistoryEditRequest,
): Map<
  string,
  {
    content: string
    included: boolean
  }
> {
  const revision = threadHistoryRevision(thread.messages)
  if (request.expectedRevision !== revision) {
    throw new Error('The thread changed while the editor was open. Reopen it and try again.')
  }
  if (request.messages.length !== thread.messages.length) {
    throw new Error('The history edit must account for every message in the thread')
  }

  const edits = new Map<string, { content: string; included: boolean }>()
  for (const edit of request.messages) {
    if (edits.has(edit.id)) throw new Error(`Message "${edit.id}" appears more than once`)
    if (!thread.messages.some((message) => message.id === edit.id)) {
      throw new Error(`Message "${edit.id}" is not in this thread`)
    }
    edits.set(edit.id, { content: edit.content, included: edit.included })
  }
  if (![...edits.values()].some((edit) => edit.included)) {
    throw new Error('Keep at least one message in the thread')
  }
  return edits
}

function editedThread(thread: Thread, request: ThreadHistoryEditRequest, now: number): Thread {
  const edits = validateRequest(thread, request)
  const messages = thread.messages.flatMap((message) => {
    const edit = edits.get(message.id)
    if (!edit?.included) return []
    return [{ ...message, content: edit.content }]
  })
  const blocked = blockedReason(messages)
  if (blocked) throw new Error(blocked)

  const next = structuredClone(thread)
  next.messages = messages
  next.messagesLoaded = true
  next.status = 'idle'
  next.updatedAt = now
  const lastHumanPrompt = messages.findLast(
    (message) => message.role === 'user' && message.origin === undefined,
  )
  if (lastHumanPrompt) next.lastPromptAt = lastHumanPrompt.createdAt
  else delete next.lastPromptAt
  delete next.contextSnapshot
  delete next.contextTrims
  delete next.currentEpoch
  delete next.continuationUsed
  return next
}

async function restoreHistory(
  projectId: string,
  threadId: string,
  messages: LLMMessage[],
  existed: boolean,
): Promise<void> {
  if (existed) await saveAgentHistory(projectId, threadId, messages)
  else await clearAgentHistory(projectId, threadId)
}

async function replaceHistory(
  projectId: string,
  previousThread: Thread,
  nextThread: Thread,
  previousHistory: LLMMessage[],
  previousHistoryExisted: boolean,
): Promise<void> {
  // A retained ACP session has private memory which cannot be rewritten. Drop
  // both the live process and its resumable binding before the new transcript
  // becomes authoritative.
  await disposeAcpSession(nextThread.id)
  await clearAcpSessionBinding(projectId, nextThread.id)

  try {
    await saveProjectThread(projectId, nextThread)
    await saveAgentHistory(projectId, nextThread.id, rebuildAgentHistory(nextThread.messages))
    await clearAgentTurnEpoch(projectId, nextThread.id)
  } catch (error) {
    await saveProjectThread(projectId, previousThread)
    await restoreHistory(projectId, previousThread.id, previousHistory, previousHistoryExisted)
    throw error
  }
}

export async function applyThreadHistoryEdit(
  projectId: string,
  threadId: string,
  request: ThreadHistoryEditRequest,
  runtime: ThreadHistoryEditRuntime,
): Promise<ThreadHistoryEditResult> {
  if (!runtime.begin(projectId, threadId)) {
    throw new Error('Wait for the current thread activity to finish before editing its history.')
  }
  try {
    const previousThread = await requireThread(projectId, threadId)
    if (previousThread.status === 'running' || (previousThread.pendingMessages?.length ?? 0) > 0) {
      throw new Error('Wait for the current thread activity to finish before editing its history.')
    }
    const previousHistoryExisted = await agentHistoryExists(projectId, threadId)
    const previousHistory = await loadAgentHistory(projectId, threadId)
    const nextThread = editedThread(previousThread, request, Date.now())
    const previous: ThreadHistoryStateSnapshot = {
      thread: previousThread,
      agentHistory: previousHistory,
      hadAgentHistory: previousHistoryExisted,
    }
    await stageThreadHistoryMutation(projectId, threadId, previous)
    const revision = threadHistoryRevision(nextThread.messages)
    try {
      await replaceHistory(
        projectId,
        previousThread,
        nextThread,
        previousHistory,
        previousHistoryExisted,
      )
      await commitThreadHistoryMutation(projectId, threadId, revision, previous)
    } catch (error) {
      await recoverThreadHistoryMutation(projectId, threadId)
      throw error
    }
    runtime.forgetAgentHistory(projectId, threadId)
    return { thread: nextThread, revision, canUndo: true }
  } finally {
    runtime.end(projectId, threadId)
  }
}

export async function undoThreadHistoryEdit(
  projectId: string,
  threadId: string,
  expectedRevision: string,
  runtime: ThreadHistoryEditRuntime,
): Promise<ThreadHistoryEditResult> {
  if (!runtime.begin(projectId, threadId)) {
    throw new Error(
      'Wait for the current thread activity to finish before undoing the history edit.',
    )
  }
  try {
    const undo = await loadThreadHistoryUndo(projectId, threadId)
    if (!undo) throw new Error('There is no history edit to undo')
    const current = await requireThread(projectId, threadId)
    const currentRevision = threadHistoryRevision(current.messages)
    if (currentRevision !== expectedRevision || currentRevision !== undo.resultingRevision) {
      await clearThreadHistoryUndo(projectId, threadId)
      throw new Error('The thread changed after that edit, so it can no longer be undone.')
    }
    const currentState: ThreadHistoryStateSnapshot = {
      thread: current,
      agentHistory: await loadAgentHistory(projectId, threadId),
      hadAgentHistory: await agentHistoryExists(projectId, threadId),
    }
    const restoredThread = structuredClone(undo.thread)
    restoredThread.messagesLoaded = true
    restoredThread.status = 'idle'
    restoredThread.updatedAt = Date.now()
    delete restoredThread.contextSnapshot
    delete restoredThread.contextTrims
    delete restoredThread.currentEpoch
    delete restoredThread.continuationUsed
    await stageThreadHistoryMutation(projectId, threadId, currentState)
    try {
      await replaceHistory(
        projectId,
        current,
        restoredThread,
        currentState.agentHistory,
        currentState.hadAgentHistory,
      )
      await restoreHistory(projectId, threadId, undo.agentHistory, undo.hadAgentHistory)
      await clearAgentTurnEpoch(projectId, threadId)
      await finishThreadHistoryUndo(projectId, threadId)
    } catch (error) {
      await recoverThreadHistoryMutation(projectId, threadId)
      throw error
    }
    runtime.forgetAgentHistory(projectId, threadId)
    return {
      thread: restoredThread,
      revision: threadHistoryRevision(restoredThread.messages),
      canUndo: false,
    }
  } finally {
    runtime.end(projectId, threadId)
  }
}
