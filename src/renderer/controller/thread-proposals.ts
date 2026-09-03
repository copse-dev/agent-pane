import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadProposal } from '@shared/threads/thread-proposal.ts'
import {
  addMessage,
  applyPreparedThreadCheckout,
  createThread,
  getThreadById,
  patchThreadAnywhere,
  setThreadProposalDecision,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import { dispatchAgentRun, startHumanTurnTree } from './message-queue.ts'

export interface ThreadProposalControllerApi {
  agent: Pick<ApiClient['agent'], 'prepareCheckout' | 'run'>
}

/**
 * Turn an accepted proposal into a running thread.
 *
 * The click is a human submit, so this walks the same road the composer walks
 * for a first message — checkout committed in main before the prompt is
 * recorded, a fresh human turn tree, then dispatch — rather than inventing a
 * second way to start a thread. What it adds is the isolation the card
 * promised: the checkout is requested as `'worktree'`, so the proposed work
 * gets its own branch and directory instead of landing on top of whatever the
 * user has open.
 *
 * Order matters. `createThread` first, so autosave sees the new id and creates
 * the thread on disk before the checkout IPC needs it; `prepareCheckout` next,
 * because a failure there must leave nothing but an empty thread the user can
 * ignore — no user bubble, no dispatch, and the offer still standing on the
 * card that made it.
 */
export async function startProposedThread(
  store: AppStore,
  api: ThreadProposalControllerApi,
  sourceThreadId: string,
  proposal: ThreadProposal,
): Promise<string> {
  const projectId = store.getState().activeProjectId
  if (!projectId) throw new Error('Open a project before starting a proposed thread')

  store.emit('composer_draft_flush')
  const threadId = createThread(store)
  setThreadTitle(store, threadId, proposal.title)
  patchThreadAnywhere(store, threadId, (t) => ({
    ...t,
    proposedBy: { threadId: sourceThreadId, proposalId: proposal.id },
  }))

  const model = getThreadById(store, threadId)?.model ?? store.getState().settings?.model
  const prepared = await api.agent.prepareCheckout(
    projectId,
    threadId,
    proposal.prompt,
    'worktree',
    model,
  )
  applyPreparedThreadCheckout(store, threadId, prepared)

  addMessage(store, threadId, 'user', proposal.prompt)
  // Recorded only once the run is actually under way: a decision written before
  // dispatch would mark the offer spent even if the checkout had failed.
  setThreadProposalDecision(store, sourceThreadId, {
    id: proposal.id,
    status: 'started',
    decidedAt: Date.now(),
    threadId,
  })
  startHumanTurnTree(store, threadId)
  dispatchAgentRun(store, api, threadId, { content: proposal.prompt })
  return threadId
}
