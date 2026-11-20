import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  suggestRoleForTask,
  type RoleRecommendation,
} from '../services/providers/model-classifier.ts'
import {
  promptRoutingContext,
  recommendTaskModel,
  type TaskModelRecommendation,
} from '../services/providers/prompt-model-routing.ts'
import { smallTasksRoutes } from '../services/providers/small-tasks-provider.ts'

type RecommendedRoute = NonNullable<TaskModelRecommendation['pick']>

function priceLine(point: RecommendedRoute['point']): string {
  if (point.local) return 'Price: runs on this device'
  if (point.plan) return `Price: included in ${point.plan}`
  return `Price: ~$${point.costPerMTok.toFixed(2)}/MTok (blended catalog rate)`
}

/** The tool's text for one recommendation. */
export function formatModelRecommendation(
  rec: TaskModelRecommendation,
  role: RoleRecommendation,
  requiredTokens: number,
): string {
  const lines = [`Assessed demand: ${rec.demand}`]
  if (rec.pick) {
    lines.push(
      rec.pick.meetsDemand
        ? `Recommended model: ${rec.pick.model}`
        : `Recommended model: ${rec.pick.model} (strongest configured model; below the ${rec.demand} demand floor)`,
      priceLine(rec.pick.point),
    )
  } else if (rec.poolSize > 0) {
    lines.push(
      `Recommended model: none. No configured model has a context window of at least ${requiredTokens.toLocaleString('en-US')} tokens.`,
    )
  } else {
    lines.push(
      'Recommended model: none. No model is configured that Copse can route to; add a provider or load a local model first.',
    )
  }
  lines.push(
    `Suggested role: ${role.role} (${role.label})`,
    `Why: ${role.rationale}`,
    'Advisory: the model in use is unchanged.',
  )
  return lines.join('\n')
}

/**
 * Experimental model-classifier tool (issues #557, #4001). Assesses a task with
 * the same classifier → Small tasks → heuristic chain as Match task, then
 * recommends from the same configured, policy-filtered model pool, so it never
 * names a model whose provider the user has not set up. Advisory only — it does
 * not change the model in use. Registered only when `modelClassifierEnabled` is on.
 */
export const suggestModelTool = defineTool({
  name: 'suggest_model',
  description:
    "Judge how demanding a task is (low / mid / top) and recommend a model from the user's configured models, using the same assessment and routing rules as Match task, plus the pipeline role (coder, reviewer, security-auditor, …) that fits it. Advisory: it does not switch models. Useful before delegating a subtask to decide whether a cheaper/faster model would do.",
  parameters: z.object({
    task: z.string().describe('The task or prompt you want to route.'),
    contextTokensEstimate: z
      .number()
      .optional()
      .describe('Rough estimate of context the task needs to hold, in tokens.'),
  }),
  async execute({ task, contextTokensEstimate }, signal) {
    if (!task.trim()) return 'suggest_model requires a non-empty task.'
    const requiredTokens = Math.max(0, contextTokensEstimate ?? 0)
    const rec = await recommendTaskModel(
      promptRoutingContext(task, []),
      smallTasksRoutes(),
      signal,
      requiredTokens,
    )
    return formatModelRecommendation(rec, suggestRoleForTask(task), requiredTokens)
  },
})
