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
import { showConfirmDialog } from './confirm-dialog.ts'
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
 * Asked when the repository cannot give the proposed thread its own checkout.
 *
 * The card offered work "in its own checkout" and the user clicked that. When
 * the policy degrades, what they would get is materially different — the agent
 * editing the working tree they already have open — so the question is put
 * before anything runs rather than reported after. Nothing has been dispatched
 * at this point; declining costs only an empty thread holding the prompt.
 *
 * The wording names the consequence, not the policy: "worktrees are disabled"
 * tells the user nothing about what is about to happen to their files.
 */
function confirmSharedCheckout(proposal: ThreadProposal): Promise<boolean> {
  return showConfirmDialog({
    message: 'Run this in your current checkout?',
    detail:
      `This project cannot give "${proposal.title}" its own checkout, so the work would ` +
      'run in the one you already have open — its edits would land alongside your ' +
      'current changes. The offer stays on the card if you would rather not.',
    confirmLabel: 'Run it here',
    cancelLabel: 'Leave it',
  })
}

/** Said once the declined work is parked, so the empty thread is not a mystery. */
function noteDeclined(): void {
  showToast('Not started. The prompt is waiting as a draft in the new thread.', {
    variant: 'info',
    durationMs: 8_000,
  })
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
      try {
        const result = await startProposedThread(store, api, sourceThreadId, accepted, {
          confirmSharedCheckout,
        })
        if (!result.started) noteDeclined()
      } catch (cause) {
        // Creating the target navigates away from the source card. Its inline
        // error is no longer visible, so also explain the failure here.
        showToast(cause instanceof Error ? cause.message : 'Could not start the proposed thread.', {
          variant: 'error',
          durationMs: 15_000,
        })
        throw cause
      }
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
