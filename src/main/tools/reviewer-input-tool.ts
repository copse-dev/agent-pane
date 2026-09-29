import { z } from 'zod'
import { defineTool } from '@shared/types'
import { REVIEWER_INPUT_TOOL } from '@shared/threads/reviewer-input.ts'

/** The transcript's saved tool call is the request; no separate host wait is needed. */
export const reviewerInputTool = defineTool({
  name: REVIEWER_INPUT_TOOL,
  description:
    'Save one concrete question or review decision for the human. This returns immediately: ' +
    'continue work that does not depend on the answer. State the decision, why it matters, ' +
    'and a recommendation when you have one. Do not use this for permissions, routine choices ' +
    'you can resolve yourself, status updates, or a question already saved. Do not claim the ' +
    'human answered until their answer arrives as a later user message. If no independent work ' +
    'remains, finish by clearly saying what is waiting for their input.',
  parameters: z.object({
    question: z.string().trim().min(1).max(300),
    context: z.string().trim().min(1).max(1200),
    recommendation: z.string().trim().min(1).max(600).optional(),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(4).optional(),
  }),
  execute() {
    return 'Saved for human review. Continue independent work; leave work that depends on this answer pending.'
  },
})
