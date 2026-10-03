import { AsyncLocalStorage } from 'node:async_hooks'
import { planCriteria, type StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'

interface PlanRunContext {
  plan: StoredThreadPlan | null
}
const context = new AsyncLocalStorage<PlanRunContext>()
export function runWithThreadPlan<T>(plan: StoredThreadPlan | null, run: () => T): T {
  return context.run({ plan: plan?.meta.status === 'abandoned' ? null : plan }, run)
}
export function getRunPlan(): StoredThreadPlan | null {
  return context.getStore()?.plan ?? null
}
export function setRunPlan(plan: StoredThreadPlan): void {
  const current = context.getStore()
  if (!current || current.plan?.meta.planId !== plan.meta.planId)
    throw new Error('No matching plan turn')
  current.plan = plan
}
export function isPlanningRun(): boolean {
  return getRunPlan()?.meta.status === 'draft'
}

// Deliberately excludes arbitrary shell, MCP, custom tools, browser control,
// todos with executable checks, child agents and background work.
const PLANNING_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'staged_diffs',
  'read_staged_diff',
  'read_skill',
  'ask_user',
  'recall',
  'update_thread_plan',
])
export function planToolBlockReason(name: string): string | null {
  if (isPlanningRun() && !PLANNING_TOOLS.has(name))
    return `${name} is unavailable while this plan is a draft. Ask the user to approve the plan before implementation.`
  if (name === 'update_thread_plan' && !isPlanningRun())
    return 'Open a draft plan before updating it.'
  if (name === 'report_plan_completion' && getRunPlan()?.meta.status !== 'approved')
    return 'Completion requires an approved plan.'
  return null
}

export function threadPlanInstructions(): string {
  const plan = getRunPlan()
  if (!plan) return ''
  const identity = `Plan ${plan.meta.planId}, revision ${String(plan.meta.currentRevision)}, SHA-256 ${plan.contentHash}`
  if (plan.meta.status === 'draft')
    return `\n\n## Optional planning workflow\n${identity} is a DRAFT. Clarify consequential choices with ask_user, offering a recommended option and reason when useful. Inspect using the available read tools, then save a complete revised plan with update_thread_plan. Preserve Goal, Constraints, Scope and Definition of done sections; use bullets for acceptance criteria. Address the user's passage feedback. Only the user can approve in the Plan editor. Finish with a short review request; do not implement or claim approval.\n\n${plan.body}\n\nFeedback (revision-specific):\n${JSON.stringify(plan.comments)}`
  return `\n\n## Approved implementation plan\n${identity} was approved for the implementation profile. Implement this exact scope using the existing tool permissions. Material scope changes need a new user-reviewed plan. Keep execution todos separate. Before finishing, call report_plan_completion with this identity and one met, partial or unverified result for every criterion, with concrete evidence or a verification gap. Never treat missing checks as met.\n\n${plan.body}\n\nCriteria:\n${JSON.stringify(planCriteria(plan.body))}`
}
