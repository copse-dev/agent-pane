import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getReviewToolRunner } from '../services/review/review-service.ts'

/**
 * Copse Reviewer on demand from the agent. Takes NO parameters — when called,
 * it reviews the thread's current changes against their base (Stage 0's build
 * and test delta where the OS sandbox allows execution, then the reviewer
 * under its lenses and the challenger over every finding) and returns the
 * report's terminal projection. The findings card renders in the conversation.
 * If a billable model is involved it first asks the user to approve the spend.
 *
 * Registered only while the `copse.review` first-party plugin is enabled — the
 * tool registration in `registry-bootstrap.ts` reads the plugin registry via
 * `syncReviewTools`, and the `plugins:set-enabled` IPC handler re-syncs on
 * toggle so the atomic plugin disable drops the tool live.
 */
export const reviewChangesTool = defineTool({
  name: 'review_changes',
  description:
    'Run Copse Reviewer over the current changes. Takes no parameters — it builds and tests the change against its base where a sandbox allows, has a reviewer model read the diff under its lens with read-only tools, and has a challenger try to refute every finding; returns the findings that stood. Use it when the user asks for a review of what changed, or before declaring a change finished. May prompt the user to approve spend when a paid model is used.',
  parameters: z.object({}),
  async execute(_args, signal) {
    const runner = getReviewToolRunner()
    if (!runner) {
      return 'Error: review is not available in this context.'
    }
    return await runner(signal)
  },
})
