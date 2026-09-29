import type { AppStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import {
  addMessage,
  getThreadById,
  getThreadProjectId,
  setThreadWorkingBrief,
} from '@shared/store/thread-helpers.ts'
import { threadGitBranchMismatch } from '@shared/git/thread-branch.ts'
import { buildTextWithAttachments } from '@copse/agent/build-text-with-attachments.ts'
import { nextWorkingBrief } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  dispatchAgentRun,
  enqueueUserMessage,
  refreshAgentRunPayload,
  startHumanTurnTree,
} from './message-queue.ts'
import { ensureThreadMessages, needsHydration } from './thread-hydration.ts'
import { READ_TERMINAL_ENABLED_SETTING } from '@shared/terminal/read-terminal.ts'

export interface CodeBlockRunSendApi {
  agent: Pick<ApiClient['agent'], 'run' | 'runMachine'>
  git: Pick<ApiClient['git'], 'currentBranch' | 'promptState'>
  settings: Pick<ApiClient['settings'], 'get'>
}

/**
 * Send a finished Play run to its thread's agent as the user's next message:
 * the same message the composer would send for the run's `@shell` chip alone.
 * The click on Play is the human action, so an idle thread starts a fresh turn
 * tree and a running one queues the result behind its current turn.
 *
 * Resolves false, sending nothing, when the thread cannot take the message —
 * it was deleted, its project is no longer loaded, or its shared checkout has
 * moved off the thread's branch (the composer's send guard) — so the caller
 * can keep the result as a draft attachment instead.
 */
export async function sendCodeBlockRunResult(
  store: AppStore,
  api: CodeBlockRunSendApi,
  result: CodeBlockRunResult,
): Promise<boolean> {
  const { projectId, threadId, shell } = result
  const completion = result.completion
  // A continuation is only valid after the recovery command completes. Keep
  // failed output available to the user, but never ask the model to continue
  // from a command that did not finish.
  if (completion && result.exitCode !== 0) return false
  // A host-native continuation follows its globally unique thread when the
  // user switches projects. An ordinary Play result is still an active-view
  // action and stays as a draft when its project is no longer active.
  const targetIsCurrent = (): boolean =>
    getThreadProjectId(store, threadId) === projectId &&
    (completion !== undefined || store.getState().activeProjectId === projectId)
  if (!targetIsCurrent()) return false
  // An evicted transcript must be loaded before a message is appended to it,
  // or the thread persists as a conversation that begins with this result.
  await ensureThreadMessages(projectId, threadId)
  if (!targetIsCurrent()) return false
  const thread = getThreadById(store, threadId)
  if (!thread || needsHydration(thread)) return false
  // Play still shows its output inline, but disabling terminal reads promises
  // that terminal contents stay private until the user explicitly sends the
  // fallback chip. A settings read failure must not turn sharing back on.
  const readTerminalEnabled = await api.settings
    .get(READ_TERMINAL_ENABLED_SETTING)
    .catch(() => false)
  if (readTerminalEnabled === false) return false
  const [branchResult, promptResult] = await Promise.allSettled([
    api.git.currentBranch(projectId, threadId),
    api.git.promptState(projectId, threadId),
  ])
  // Like the composer's Send, an unverifiable checkout is not a match: keep
  // the result as a draft attachment rather than run the agent on a checkout
  // that may have moved off the thread's branch.
  if (branchResult.status === 'rejected') return false
  // The settings and Git reads above cross async boundaries. Re-check exact
  // ownership before mutating the store or dispatching the continuation.
  if (!targetIsCurrent()) return false
  const currentBranch = branchResult.value
  const promptState = promptResult.status === 'fulfilled' ? promptResult.value : null
  const current = getThreadById(store, threadId)
  if (!current) return false
  if (
    threadGitBranchMismatch(current.gitBranch, currentBranch, {
      isolatedWorktree: current.worktree !== undefined,
    })
  )
    return false

  const messageText = completion?.prompt ?? ''
  const content = buildTextWithAttachments(
    messageText,
    [],
    [{ label: `Shell: ${shell.label}`, content: shell.content }],
  )
  const workingBrief = nextWorkingBrief(current.workingBrief, content)
  const workingBriefChanged = workingBrief !== undefined && workingBrief !== current.workingBrief
  const payload: AgentRunPayload = {
    content,
    invokedSkills: [],
    priorTodos: current.todos ?? [],
    ...(workingBrief !== undefined ? { workingBrief } : {}),
  }
  const shellAttachment = { kind: 'shell' as const, label: shell.label, content: shell.content }
  const messageMeta = {
    ...(promptState
      ? {
          ...(promptState.startingCommit !== null
            ? { startingCommit: promptState.startingCommit }
            : {}),
          dirty: promptState.dirty,
        }
      : {}),
  }
  if (completion) {
    const machineResult = await api.agent.runMachine({
      projectId,
      threadId,
      operationId: completion.operationId,
      turnTreeId: completion.turnTreeId,
      payload: JSON.stringify(refreshAgentRunPayload(store, threadId, payload)),
      display: {
        content: messageText,
        attachments: [shellAttachment],
        ...messageMeta,
      },
    })
    if (machineResult === 'completed' || machineResult === 'duplicate') {
      if (workingBriefChanged) setThreadWorkingBrief(store, threadId, workingBrief)
      return true
    }
    addMessage(
      store,
      threadId,
      'error',
      machineResult === 'budget-exhausted'
        ? 'Git recovery completed, but the automatic follow-up did not start because this turn reached its auto-continuation budget. Send a message to continue.'
        : 'Git recovery completed, but the thread advanced before the automatic follow-up could start. Send a message to continue.',
    )
    return false
  }
  if (workingBriefChanged) setThreadWorkingBrief(store, threadId, workingBrief)
  const messageId = addMessage(
    store,
    threadId,
    'user',
    messageText,
    undefined,
    [shellAttachment],
    messageMeta,
  )
  const queued = { messageId, payload, createdAt: Date.now() }
  if (getThreadById(store, threadId)?.status === 'running') {
    enqueueUserMessage(store, threadId, queued)
  } else {
    startHumanTurnTree(store, threadId)
    dispatchAgentRun(store, api, threadId, payload, queued)
  }
  return true
}
