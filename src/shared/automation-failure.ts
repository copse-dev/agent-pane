import type { AutomationFailureCode } from './types/automations.ts'

/** Where the user can fix a failure. The manager and Activity turn this into one button. */
export type AutomationFailureAction =
  | 'open-run'
  | 'open-model-settings'
  | 'open-provider-settings'
  | 'open-container-settings'
  | 'open-automations'
  | 'none'

export interface AutomationFailureDescription {
  /** Short noun phrase used as a row label. */
  title: string
  /** What the user should do next, in one sentence. */
  remedy: string
  action: AutomationFailureAction
  actionLabel: string
}

const DESCRIPTIONS: Record<AutomationFailureCode, AutomationFailureDescription> = {
  'approval-stalled': {
    title: 'Waiting for approval',
    remedy:
      'The run needs an answer nobody has given. Open it to approve or deny; or add the exact tool to the automation so it stops asking.',
    action: 'open-run',
    actionLabel: 'Open run',
  },
  'no-model': {
    title: 'Model unavailable',
    remedy:
      'The automation’s model is not configured or no longer exists. Pick another model in the automation.',
    action: 'open-automations',
    actionLabel: 'Edit automation',
  },
  'container-missing': {
    title: 'Container engine unavailable',
    remedy: 'Start Docker (or fix the container engine), then run again.',
    action: 'open-container-settings',
    actionLabel: 'Container settings',
  },
  'auth-expired': {
    title: 'Sign-in expired',
    remedy: 'The provider rejected the credentials. Sign in again or replace the API key.',
    action: 'open-provider-settings',
    actionLabel: 'Provider settings',
  },
  'worktree-failed': {
    title: 'Checkout could not be prepared',
    remedy:
      'No isolated checkout could be created, so nothing ran. The prompt is kept as a draft in the run; resolve the cause and send it.',
    action: 'open-run',
    actionLabel: 'Open run',
  },
  'scheduler-stopped': {
    title: 'Scheduler stopped',
    remedy:
      'Scheduled and event triggers are not firing. Copse retries automatically; if this persists, toggle the Automations plugin off and on.',
    action: 'open-automations',
    actionLabel: 'Open Automations',
  },
  unknown: {
    title: 'Run failed',
    remedy: 'Open the run to read the error.',
    action: 'open-run',
    actionLabel: 'Open run',
  },
}

export function describeAutomationFailure(
  code: AutomationFailureCode,
): AutomationFailureDescription {
  return DESCRIPTIONS[code]
}

/**
 * Best-effort cause for a failure known only by its message (an error written to a
 * thread after dispatch). Callers that know the cause pass the code directly; this
 * never invents `approval-stalled` or `scheduler-stopped`, which are detected by state.
 */
export function classifyAutomationFailureMessage(message: string): AutomationFailureCode {
  if (
    /\b(401|unauthori[sz]ed|authentication|sign[- ]?in (expired|required)|invalid api key|api key (was )?(rejected|invalid))/i.test(
      message,
    )
  )
    return 'auth-expired'
  if (
    /docker|container engine|apple container/i.test(message) &&
    /unavailable|not running|cannot connect|not found/i.test(message)
  )
    return 'container-missing'
  if (
    /model.*(not found|unknown|unavailable|not configured|no longer)|no model|does not exist.*model/i.test(
      message,
    )
  )
    return 'no-model'
  if (/worktree|checkout|isolated/i.test(message)) return 'worktree-failed'
  return 'unknown'
}

/** How long an unattended run may sit on an approval or question before it counts as stalled. */
export const AUTOMATION_APPROVAL_STALL_MS = 15 * 60_000

/** Whether a run waiting since `since` has waited long enough to be called stalled. */
export function isApprovalStalled(since: number | null, now: number): boolean {
  return since !== null && now - since >= AUTOMATION_APPROVAL_STALL_MS
}
