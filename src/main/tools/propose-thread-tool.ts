import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  parseThreadProposal,
  threadProposalAcknowledgement,
  THREAD_PROPOSAL_TOOL,
} from '@shared/threads/thread-proposal.ts'

/**
 * Offer the user a separate thread for work that does not belong in this one.
 *
 * Deliberately does nothing: the whole tool is the arguments. The renderer draws
 * the card straight from this call's `args` (already in the transcript, already
 * persisted, already addressable by tool-call id), and only a click creates a
 * thread — so there is no IPC, no pending state in main, and nothing to leak if
 * the run is abandoned mid-turn.
 *
 * It returns immediately rather than blocking on the user, which is what keeps
 * this an offer rather than a gate: an unanswered proposal costs the current
 * turn nothing and outlives it. See `thread-proposal.ts` for why the wording of
 * the acknowledgement matters.
 */
export const proposeThreadTool = defineTool({
  name: THREAD_PROPOSAL_TOOL,
  description:
    'Offer the user a SEPARATE follow-up thread, which they can start with one click. ' +
    'It runs in its own isolated checkout, so it will not disturb the work in this thread. ' +
    'Use it for real work you noticed but were not asked to do — a refactor the change exposed, ' +
    'a missing test, a migration, a bug in adjacent code — instead of silently widening the ' +
    'current task or burying the suggestion in prose. Do NOT use it for work the user just ' +
    'asked for (do that here), for questions (use ask_user), or to split a task you can finish now. ' +
    'This does not block: you are told it was offered, never whether it was accepted, so ' +
    'continue the current task and do not propose the same thing twice.',
  parameters: z.object({
    title: z
      .string()
      .min(1)
      .describe('Short name for the work, as a thread title. E.g. "Migrate settings to Zod".'),
    summary: z
      .string()
      .min(1)
      .describe(
        'What the new thread would DO, in plain language for a human — one or two sentences, ' +
          'no tool names, no jargon, no restating of the prompt. This is the description the ' +
          'user reads before deciding.',
      ),
    rationale: z
      .string()
      .optional()
      .describe('Why it deserves its own thread rather than this one. One sentence.'),
    prompt: z
      .string()
      .min(1)
      .describe(
        'The exact prompt the new thread starts with, written as an instruction to an agent ' +
          'that has none of this conversation as context. State the goal, the relevant paths, ' +
          'and how to verify it.',
      ),
    files: z
      .array(z.string())
      .optional()
      .describe('Workspace-relative paths the work is expected to touch, for display.'),
  }),
  execute(args) {
    // Re-parsed rather than trusted: the card the user sees is built by the same
    // decoder from the same bytes, so a proposal the renderer would refuse to
    // draw must not be reported to the model as offered.
    const proposal = parseThreadProposal('preview', args)
    if (!proposal) {
      return 'Not offered: a proposal needs a non-empty title, summary and prompt. Nothing was shown to the user.'
    }
    return threadProposalAcknowledgement(proposal)
  },
})
