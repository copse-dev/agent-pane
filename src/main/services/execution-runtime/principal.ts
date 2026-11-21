/**
 * Execution principals (`docs/plans/execution-runtime-security.md`, R1 and
 * binding decision 11).
 *
 * An interactive turn acts for the local human. A scheduled run acts for an
 * automation principal bound to its project, schedule and run — but only when
 * main-owned schedule state corroborates the thread's claim. Thread metadata is
 * renderer-visible, so an uncorroborated claim is never promoted to an
 * automation principal; it stays with the human who opened the thread.
 *
 * Kept free of the automation service's import graph: low-level spawn code
 * reaches this module, so the corroborating check is registered at startup.
 */
import {
  automationPrincipal,
  humanPrincipal,
  type ExecutionPrincipal,
} from '@shared/threads/execution-runtime.ts'
import {
  currentThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context-store.ts'

type AutomationClaim = NonNullable<ThreadExecutionContext['automation']>

/** Whether main-owned schedule state confirms that this run belongs to the schedule. */
export type AutomationRunCorroborator = (
  projectId: string,
  threadId: string,
  automation: AutomationClaim,
) => boolean

let registeredCorroborator: AutomationRunCorroborator | null = null

/** Register the main-owned check; until then no thread resolves to an automation principal. */
export function setAutomationRunCorroborator(corroborate: AutomationRunCorroborator | null): void {
  registeredCorroborator = corroborate
}

export function resolveExecutionPrincipal(
  context: Pick<ThreadExecutionContext, 'projectId' | 'threadId' | 'automation'>,
  corroborate: AutomationRunCorroborator | null = registeredCorroborator,
): ExecutionPrincipal {
  const claim = context.automation
  if (claim && corroborate?.(context.projectId, context.threadId, claim) === true) {
    return automationPrincipal(context.projectId, claim.scheduleId, claim.triggeredAt)
  }
  return humanPrincipal(context.projectId)
}

/**
 * The principal of the current agent turn when it owns this project and
 * thread, or null outside a turn or for a record about another thread.
 */
export function currentExecutionPrincipal(owner?: {
  readonly projectId: string
  readonly threadId: string
}): ExecutionPrincipal | null {
  const context = currentThreadExecutionContext()
  if (!context) return null
  if (owner && (owner.projectId !== context.projectId || owner.threadId !== context.threadId)) {
    return null
  }
  return resolveExecutionPrincipal(context)
}
