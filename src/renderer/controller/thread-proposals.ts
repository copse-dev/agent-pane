import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadProposal } from '@shared/threads/thread-proposal.ts'
import type { ThreadCheckoutMode } from '@shared/types/worktree.ts'
import {
  addMessage,
  applyPreparedThreadCheckout,
  createThread,
  getThreadById,
  patchThreadAnywhere,
  setThreadDraftPrompt,
  setThreadProposalDecision,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import { dispatchAgentRun, startHumanTurnTree } from './message-queue.ts'
import { awaitPendingThreadPersistence } from './persistence.ts'

export interface ThreadProposalControllerApi {
  agent: Pick<ApiClient['agent'], 'prepareCheckout' | 'run'>
}

export interface StartProposedThreadOptions {
  /**
   * Asked **before dispatch**, and only when the repository could not grant the
   * isolated checkout the card offered. Resolving `false` leaves the work
   * unstarted.
   *
   * Injected rather than imported so the controller stays free of views (the
   * same reason `automations.ts` keeps its own error formatter). It is not
   * optional: a caller with no way to ask cannot honour the promise the card
   * made, and silently proceeding is the exact defect this exists to prevent.
   */
  confirmSharedCheckout: (proposal: ThreadProposal) => Promise<boolean>
}

export type StartProposedThreadResult =
  | { started: true; threadId: string; checkoutMode: ThreadCheckoutMode }
  /**
   * The repository could not isolate the work and the user declined to run it
   * in the shared checkout. Nothing ran; the prompt is kept as a draft on
   * `threadId` so the click is not simply lost, and the offer still stands.
   */
  | { started: false; threadId: string; reason: 'shared-checkout-declined' }

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
 * Order matters. `createThread` first, then await its in-flight autosave so the
 * thread exists on disk before the checkout IPC needs it; `prepareCheckout` next,
 * because a failure there must leave nothing but an empty thread the user can
 * ignore — no user bubble, no dispatch, and the offer still standing on the
 * card that made it.
 *
 * ## When isolation is refused
 *
 * Current policy fails unavailable explicit worktree requests closed. Still
 * defend against a returned shared grant, such as a persisted checkout decision.
 * The user clicked a card offering work
 * "in its own checkout", so a degraded grant means the thing they agreed to is
 * not the thing on offer — and the difference is not cosmetic. A shared
 * checkout means the agent edits the working tree they already have open,
 * alongside whatever they are doing in it.
 *
 * Telling them afterwards is too late: by then the run has started and the
 * files are already moving. So consent is taken **before dispatch**, while
 * nothing has run and the only thing that exists is an empty thread. Declining
 * keeps the prompt as a draft rather than discarding the click, records no
 * decision (the offer is still standing, which is true — it was never started),
 * and leaves the working tree untouched.
 */
export async function startProposedThread(
  store: AppStore,
  api: ThreadProposalControllerApi,
  sourceThreadId: string,
  proposal: ThreadProposal,
  options: StartProposedThreadOptions,
): Promise<StartProposedThreadResult> {
  const projectId = store.getState().activeProjectId
  if (!projectId) throw new Error('Open a project before starting a proposed thread')

  store.emit('composer_draft_flush')
  const threadId = createThread(store)
  setThreadTitle(store, threadId, proposal.title)
  patchThreadAnywhere(store, threadId, (t) => ({
    ...t,
    proposedBy: { threadId: sourceThreadId, proposalId: proposal.id },
  }))
  // Starting autosave is not the same as completing it. The main-process
  // checkout transaction rejects a thread whose create has not landed yet.
  await awaitPendingThreadPersistence()

  const model = getThreadById(store, threadId)?.model ?? store.getState().settings?.model
  const prepared = await api.agent.prepareCheckout(
    projectId,
    threadId,
    proposal.prompt,
    'worktree',
    model,
  )
  applyPreparedThreadCheckout(store, threadId, prepared)

  if (prepared.checkoutMode !== 'worktree' && !(await options.confirmSharedCheckout(proposal))) {
    // Nothing has run: no user message, no turn tree, no dispatch. The prompt
    // survives as a draft so the user can send it themselves — or enable
    // worktrees and take the offer again, which is still on the card.
    setThreadDraftPrompt(store, threadId, proposal.prompt)
    return { started: false, threadId, reason: 'shared-checkout-declined' }
  }

  addMessage(store, threadId, 'user', proposal.prompt)
  // Recorded only once the run is actually under way: a decision written before
  // dispatch would mark the offer spent even if the checkout had failed or the
  // user had declined the shared fallback.
  setThreadProposalDecision(store, sourceThreadId, {
    id: proposal.id,
    status: 'started',
    decidedAt: Date.now(),
    threadId,
    checkoutMode: prepared.checkoutMode,
  })
  startHumanTurnTree(store, threadId)
  dispatchAgentRun(store, api, threadId, { content: proposal.prompt })
  return { started: true, threadId, checkoutMode: prepared.checkoutMode }
}
