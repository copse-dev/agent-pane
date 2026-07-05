import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getModelComparisonRunner } from '../services/model-comparison-runner.ts'

/**
 * Experimental model comparison tool. Takes NO parameters — when called, it runs
 * the current working-diff review through the two configured comparison models
 * and a judge that compares their verdicts, then returns the judge's comparison.
 * The full side-by-side is also rendered as a card in the conversation. If a
 * billable model is involved it first asks the user to approve the spend.
 * Registered only when `modelComparisonEnabled` is on.
 */
export const compareModelsTool = defineTool({
  name: 'compare_models',
  description:
    'Compare two models on the current working diff. Takes no parameters — it runs a read-only review of the diff through two configured models independently, then a judge model compares their verdicts (agreements, disagreements, unique findings) and returns that comparison. Use it when the user wants a second opinion or to cross-check a review across models. May prompt the user to approve spend when a paid model is used.',
  parameters: z.object({}),
  async execute(_args, signal) {
    const runner = getModelComparisonRunner()
    if (!runner) {
      return 'Error: model comparison is not available in this context.'
    }
    return await runner(signal)
  },
})
