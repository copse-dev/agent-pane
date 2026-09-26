import type { AppStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import { addMessage, getThreadById, setThreadWorkingBrief } from '@shared/store/thread-helpers.ts'
import { threadGitBranchMismatch } from '@shared/git/thread-branch.ts'
import { buildTextWithAttachments } from '@copse/agent/build-text-with-attachments.ts'
import { nextWorkingBrief } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { dispatchAgentRun, enqueueUserMessage, startHumanTurnTree } from './message-queue.ts'
import { ensureThreadMessages, needsHydration } from './thread-hydration.ts'

export interface CodeBlockRunSendApi {
  agent: Pick<ApiClient['agent'], 'run'>
  git: Pick<ApiClient['git'], 'currentBranch' | 'promptState'>
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
  // An evicted transcript must be loaded before a message is appended to it,
  // or the thread persists as a conversation that begins with this result.
  await ensureThreadMessages(projectId, threadId)
  const thread = getThreadById(store, threadId)
  if (!thread || needsHydration(thread)) return false
  const [branchResult, promptResult] = await Promise.allSettled([
    api.git.currentBranch(projectId, threadId),
    api.git.promptState(projectId, threadId),
  ])
  // Like the composer's Send, an unverifiable checkout is not a match: keep
  // the result as a draft attachment rather than run the agent on a checkout
  // that may have moved off the thread's branch.
  if (branchResult.status === 'rejected') return false
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

  const content = buildTextWithAttachments(
    '',
    [],
    [{ label: `Shell: ${shell.label}`, content: shell.content }],
  )
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
  const messageId = addMessage(
    store,
    threadId,
    'user',
    '',
    undefined,
    [{ kind: 'shell', label: shell.label, content: shell.content }],
    promptState
      ? {
          ...(promptState.startingCommit !== null
            ? { startingCommit: promptState.startingCommit }
            : {}),
          dirty: promptState.dirty,
        }
      : undefined,
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
