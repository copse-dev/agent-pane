import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAdvisorRunner } from '../services/advisor-runner.ts'

/**
 * Experimental client-side advisor tool (issue #566). Takes NO parameters — when
 * called, the executor's full conversation transcript is forwarded automatically
 * to a larger advisor model, matching the native `advisor_20260301` contract.
 * The advisor returns strategic guidance; the executor keeps doing the work.
 * Registered only when `advisorStrategyEnabled` is on.
 */
export const advisorTool = defineTool({
  name: 'advisor',
  description:
    'Consult a stronger advisor model that sees your full conversation transcript. Takes no parameters — your entire history (task, every tool call and result, your reasoning) is forwarded automatically. Call it before substantive work (before writing, before committing to an interpretation), when stuck, and before declaring the task done. It returns strategic guidance; it does not do the work for you.',
  parameters: z.object({}),
  async execute(_args, signal) {
    const runner = getAdvisorRunner()
    if (!runner) {
      return 'Error: the advisor is not available in this context.'
    }
    return await runner(signal)
  },
})
