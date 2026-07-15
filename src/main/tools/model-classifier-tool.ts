import { z } from 'zod'
import { defineTool } from '@shared/types'
import { classifyModelForTask, suggestRoleForTask } from '../services/providers/model-classifier.ts'

/**
 * Experimental model-classifier tool (issue #557). Places a task's demand on
 * the shared model intellect scale (model-intellect.ts) and names a
 * representative model, so work can be routed to the cheapest model that can
 * handle it. Advisory only — it does not change the model in use; wiring the
 * recommendation into provider selection is a follow-up. Registered only when
 * `modelClassifierEnabled` is on.
 */
export const suggestModelTool = defineTool({
  name: 'suggest_model',
  description:
    'Recommend where a task sits on the model intellect scale (low / mid / top band) and which pipeline role (coder, reviewer, security-auditor, …) fits it, with a representative model id, confidence, and rationale. Advisory: it does not switch models. Useful before delegating a subtask to decide whether a cheaper/faster model would do.',
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
      `Recommended intellect band: ${rec.band} (intellect ${String(rec.intellect)})`,
      `Representative model: ${rec.model}`,
      `Suggested role: ${roleRec.role} (${roleRec.label})`,
      `Confidence: ${rec.confidence.toFixed(2)}`,
      `Why: ${rec.rationale}; ${roleRec.rationale}`,
    ].join('\n')
  },
})
