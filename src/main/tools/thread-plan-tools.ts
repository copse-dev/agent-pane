import { z } from 'zod'
import { defineTool } from '@shared/types'
import { planCriterionResultSchema } from '@copse/thread-store/plan-schema.ts'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import { getRunPlan, isPlanningRun, setRunPlan } from '../services/thread-plan-context.ts'
import { reviseThreadPlan, reportThreadPlanCompletion } from '../services/thread-store.ts'

export const updateThreadPlanTool = defineTool({
  name: 'update_thread_plan',
  description:
    'Save a new revision of the current draft plan for user review. This cannot approve a plan or start implementation. Include Goal, Constraints, Scope and Definition of done sections, with bullet acceptance criteria.',
  parameters: z.object({
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(100000),
  }),
  async execute({ expectedRevision, title, body }) {
    const owner = getThreadExecutionContext()
    const plan = getRunPlan()
    if (!owner || !plan || !isPlanningRun()) throw new Error('No draft plan in this turn')
    const updated = await reviseThreadPlan(
      owner.projectId,
      owner.threadId,
      plan.meta.planId,
      expectedRevision,
      { title, body },
    )
    setRunPlan(updated)
    return `Saved plan revision ${String(updated.meta.currentRevision)}. The user can review and approve it in Plan.`
  },
})
export const reportPlanCompletionTool = defineTool({
  name: 'report_plan_completion',
  description:
    'Report evidence against every criterion in the exact approved plan. Use met only for verified outcomes, partial for incomplete work, and unverified for missing validation. The report is visible in Plan.',
  parameters: z.object({
    planId: z.uuid(),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    results: z.array(planCriterionResultSchema).max(200),
  }),
  async execute(input) {
    const owner = getThreadExecutionContext()
    const plan = getRunPlan()
    if (
      !owner ||
      plan?.meta.status !== 'approved' ||
      plan.meta.planId !== input.planId ||
      plan.contentHash !== input.contentHash ||
      plan.meta.currentRevision !== input.revision
    )
      throw new Error('Report must match this turn’s approved plan')
    const updated = await reportThreadPlanCompletion(owner.projectId, owner.threadId, input)
    setRunPlan(updated)
    return 'Completion evidence saved to the approved plan.'
  },
})
