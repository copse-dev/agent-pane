import type { AppStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { MessageOrigin } from '@shared/types'
import { addMessage, getThreadById, setThreadWorkingBrief } from '@shared/store/thread-helpers.ts'
import { threadGitBranchMismatch } from '@shared/git/thread-branch.ts'
import { buildTextWithAttachments } from '@copse/agent/build-text-with-attachments.ts'
import { nextWorkingBrief } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { dispatchAgentRun, enqueueUserMessage, startHumanTurnTree } from './message-queue.ts'
import { ensureThreadMessages, needsHydration } from './thread-hydration.ts'
import { READ_TERMINAL_ENABLED_SETTING } from '@shared/terminal/read-terminal.ts'

export interface CodeBlockRunSendApi {
  agent: Pick<ApiClient['agent'], 'run'>
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
  // Renderer thread ids are scoped to their project. If the user changed
  // projects while the command ran, a same-id thread in the newly active
  // project must not receive the old project's output.
  if (store.getState().activeProjectId !== projectId) return false
  // An evicted transcript must be loaded before a message is appended to it,
  // or the thread persists as a conversation that begins with this result.
  await ensureThreadMessages(projectId, threadId)
  if (store.getState().activeProjectId !== projectId) return false
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
  // The settings and Git reads above cross async boundaries. Re-check the
  // project before mutating the store so a project switch during either read
  // cannot send this output to a newly active same-id thread.
  if (store.getState().activeProjectId !== projectId) return false
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
  const origin: MessageOrigin | undefined = completion
    ? { kind: 'machine', operationId: completion.operationId }
    : undefined
  const workingBrief = nextWorkingBrief(current.workingBrief, content)
  if (workingBrief && workingBrief !== current.workingBrief) {
    setThreadWorkingBrief(store, threadId, workingBrief)
  }
  const payload: AgentRunPayload = {
    content,
    invokedSkills: [],
    priorTodos: current.todos ?? [],
    ...(workingBrief !== undefined ? { workingBrief } : {}),
  }
  const messageMeta = {
    ...(promptState
      ? {
          ...(promptState.startingCommit !== null
            ? { startingCommit: promptState.startingCommit }
            : {}),
          dirty: promptState.dirty,
        }
      : {}),
    ...(origin ? { origin } : {}),
  }
  const messageId = addMessage(
    store,
    threadId,
    'user',
    messageText,
    undefined,
    [{ kind: 'shell', label: shell.label, content: shell.content }],
    messageMeta,
  )
  const queued = { messageId, payload, createdAt: Date.now() }
  if (getThreadById(store, threadId)?.status === 'running') {
    enqueueUserMessage(store, threadId, queued)
  } else {
    if (!completion) startHumanTurnTree(store, threadId)
    dispatchAgentRun(store, api, threadId, payload, queued)
  }
  return true
}
