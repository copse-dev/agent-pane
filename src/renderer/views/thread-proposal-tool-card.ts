import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ToolCall } from '@shared/types'
import {
  parseThreadProposal,
  threadProposalStatus,
  findThreadProposalDecision,
  THREAD_PROPOSAL_TOOL,
  type ThreadProposal,
} from '@shared/threads/thread-proposal.ts'
import {
  clearThreadProposalDecisionFor,
  getThreadById,
  setThreadProposalDecision,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { startProposedThread } from '../controller/thread-proposals.ts'
import { showToast } from './toast.ts'
import { createThreadProposalCard, type ThreadProposalCardState } from './thread-proposal-card.ts'

/**
 * Adapter between a `propose_thread` tool call in the transcript and the card
 * the user acts on. Keeps `conversation.ts` free of proposal specifics: it asks
 * for a card, or gets `null` and falls back to the ordinary tool card.
 *
 * Everything the card shows is derived on each build — the proposal from the
 * call's own arguments, the answer from the offering thread's meta — so a
 * reload, a thread switch, and a live tick all produce the same card without a
 * second copy of the offer being persisted anywhere.
 */

export function isThreadProposalCall(tc: ToolCall): boolean {
  return tc.name === THREAD_PROPOSAL_TOOL
}

function cardState(
  store: AppStore,
  sourceThreadId: string,
  proposalId: string,
): ThreadProposalCardState {
  const decisions = getThreadById(store, sourceThreadId)?.threadProposals
  const status = threadProposalStatus(decisions, proposalId)
  const decision = findThreadProposalDecision(decisions, proposalId)
  const startedId = decision?.threadId
  // A started thread the user has since deleted leaves the card truthful but
  // without a destination: still "started", no dead "Open" button.
  const threadId = startedId && getThreadById(store, startedId) ? startedId : undefined
  return {
    status,
    ...(threadId ? { threadId } : {}),
    ...(decision?.checkoutMode ? { checkoutMode: decision.checkoutMode } : {}),
  }
}

/**
 * Said the moment the isolation the card offered turns out to be unavailable.
 *
 * Starting a proposal navigates to the new thread, so the corrected settled row
 * is behind the user by the time it exists — durable, but not in front of them.
 * This is the half that is: one quiet notice, at the moment the promise breaks,
 * naming the consequence rather than the policy.
 */
function warnSharedCheckout(): void {
  showToast(
    'This project cannot give the thread its own checkout, so it started in the ' +
      'shared one — its changes land in the working tree you already have open.',
    { variant: 'info', durationMs: 12_000 },
  )
}

/**
 * The part of a proposal card's render signature that the tool call itself does
 * not carry. `conversation.ts` folds this into the card signature so answering
 * an offer rebuilds the card, exactly as a changed tool result would.
 */
export function threadProposalCardSignature(
  tc: ToolCall,
  store: AppStore,
  sourceThreadId: string,
): string | undefined {
  if (!isThreadProposalCall(tc)) return undefined
  const state = cardState(store, sourceThreadId, tc.id)
  return `${state.status}:${state.threadId ?? ''}:${state.checkoutMode ?? ''}`
}

export function createThreadProposalToolCard(
  tc: ToolCall,
  store: AppStore,
  api: ApiClient,
  sourceThreadId: string,
): HTMLDetailsElement | null {
  const proposal = parseThreadProposal(tc.id, tc.args)
  // A call still streaming its arguments (or one the model malformed) has no
  // card to draw yet; the ordinary tool card covers it until the args land.
  if (!proposal) return null

  return createThreadProposalCard(proposal, cardState(store, sourceThreadId, tc.id), {
    onStart: async (accepted: ThreadProposal) => {
      const started = await startProposedThread(store, api, sourceThreadId, accepted)
      if (started.checkoutMode !== 'worktree') warnSharedCheckout()
    },
    onDismiss: (dismissed: ThreadProposal) => {
      setThreadProposalDecision(store, sourceThreadId, {
        id: dismissed.id,
        status: 'dismissed',
        decidedAt: Date.now(),
      })
    },
    onRestore: (restored: ThreadProposal) => {
      clearThreadProposalDecisionFor(store, sourceThreadId, restored.id)
    },
    onOpenThread: (threadId: string) => {
      switchThread(store, threadId)
    },
  })
}
