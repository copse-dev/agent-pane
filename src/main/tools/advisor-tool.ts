import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAdvisorRunner } from '../services/advisor-runner.ts'

/**
 * Experimental client-side advisor tool (issue #566). Your full conversation
 * transcript plus verified repo state is forwarded automatically to a larger
 * advisor model for strategic guidance. Parameters are optional client-side
 * enhancements — the native `advisor_20260301` tool takes none, so the no-arg
 * call stays a drop-in: `question` focuses the advice, `include_diff` attaches
 * the current working-tree diff. Registered only when `advisorStrategyEnabled`
 * is on.
 */
export const advisorTool = defineTool({
  name: 'advisor',
  description:
    'Consult a stronger advisor model that sees your full conversation transcript and the verified repo state. Call it before substantive work (before writing, before committing to an interpretation), when stuck, and before declaring the task done. Optional: pass `question` to ask something specific, and `include_diff: true` to attach your current working-tree diff. It returns strategic guidance; it does not do the work for you.',
  parameters: z.object({
    question: z
      .string()
      .max(2000)
      .optional()
      .describe('A specific question to focus the advice on. Omit for general strategic guidance.'),
    include_diff: z
      .boolean()
      .optional()
      .describe('Attach the current working-tree diff (staged + unstaged) to the advisor context.'),
  }),
  async execute({ question, include_diff }, signal) {
    const runner = getAdvisorRunner()
    if (!runner) {
      return 'Error: the advisor is not available in this context.'
    }
    // The advice is prose (headings, lists, code): render it through the
    // Markdown pipeline in the tool card rather than a raw <pre>.
    return {
      result: await runner(signal, {
        ...(question ? { question } : {}),
        ...(include_diff ? { includeDiff: include_diff } : {}),
      }),
      resultFormat: 'markdown',
    }
  },
})
