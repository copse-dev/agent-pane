import { z } from 'zod'
import { defineTool } from '@shared/types'
import { classifyModelForTask, suggestRoleForTask } from '../services/providers/model-classifier.ts'

/**
 * Experimental model-classifier tool (issue #557). Returns a recommended
 * capability tier and representative model for a task so work can be routed to
 * the cheapest model that can handle it. Advisory only — it does not change the
 * model in use; wiring the recommendation into provider selection is a
 * follow-up. Registered only when `modelClassifierEnabled` is on.
 */
export const suggestModelTool = defineTool({
  name: 'suggest_model',
  description:
    'Recommend which model capability tier (fast / balanced / frontier) and pipeline role (coder, reviewer, security-auditor, …) best fit a task, with a representative model id, confidence, and rationale. Advisory: it does not switch models. Useful before delegating a subtask to decide whether a cheaper/faster model would do.',
  parameters: z.object({
    task: z.string().describe('The task or prompt you want to route.'),
    contextTokensEstimate: z
      .number()
      .optional()
      .describe('Rough estimate of context the task needs to hold, in tokens.'),
    agentic: z
      .boolean()
      .optional()
      .describe('True if the task drives tools/subagents in a long loop.'),
  }),
  execute({ task, contextTokensEstimate, agentic }) {
    if (!task.trim()) return 'suggest_model requires a non-empty task.'
    const rec = classifyModelForTask({ task, contextTokensEstimate, agentic })
    const roleRec = suggestRoleForTask(task)
    return [
      `Recommended tier: ${rec.tier}`,
      `Representative model: ${rec.model}`,
      `Suggested role: ${roleRec.role} (${roleRec.label})`,
      `Confidence: ${rec.confidence.toFixed(2)}`,
      `Why: ${rec.rationale}; ${roleRec.rationale}`,
    ].join('\n')
  },
})
