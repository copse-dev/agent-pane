/** A project-owned recurring schedule persisted by the automations plugin. */
export type AutomationLiveWorktreeLimit = 1 | 2 | 3

/**
 * One exact approval a schedule may reuse without interrupting a future run.
 *
 * Deliberately narrow: shell commands, file changes, web origins, and broad ACP
 * permission kinds are not representable here. Those approvals need a different
 * scope than an exact Copse action or MCP tool name.
 */
export interface AutomationPermission {
  kind: 'copse-action' | 'mcp-tool'
  toolName: string
}

/** One currently-selectable permission shown by the schedule editor. */
export interface AutomationPermissionOption {
  permission: AutomationPermission
  label: string
  detail: string
}

/** Stable key used to deduplicate grants without flattening their typed shape on disk. */
export function automationPermissionKey(permission: AutomationPermission): string {
  return JSON.stringify([permission.kind, permission.toolName])
}

export interface AutomationSchedule {
  id: string
  projectId: string
  name: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
  /** Maximum unresolved linked checkouts this schedule may retain. Defaults to 1. */
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
  /** Exact tools/actions explicitly allowed to run unattended for this schedule. */
  permissions?: AutomationPermission[]
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastCreatedThreadId?: string
  /** Most recent trigger skipped because retained worktrees filled the limit. */
  lastWorktreeLimitAt?: number
  /** Most recent trigger that failed or was skipped for a reason the user should see. */
  lastProblem?: AutomationProblem
}

/**
 * Why a scheduled trigger did not start a run. Cleared by the next run that
 * starts, so it always describes the schedule's latest unresolved attempt.
 */
export interface AutomationProblem {
  at: number
  /** `failed`: the trigger threw. `pending-start`: an earlier run was never started. */
  kind: 'failed' | 'pending-start'
  message: string
}

/** Editable fields accepted by create/update IPC. Project ownership is separate. */
export interface AutomationScheduleInput {
  id?: string
  name: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
  permissions?: AutomationPermission[]
}

/** Versioned event workflow. Existing cron schedules keep their stored shape until migrated. */
export interface BranchCiAutomation {
  v: 1
  id: string
  projectId: string
  name: string
  trigger: { kind: 'github-ci-failed'; repository: string; branch: string }
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees: AutomationLiveWorktreeLimit
  revision: string
  createdAt: number
  updatedAt: number
  /** Recent run+attempt identities, advanced only after inbox admission. */
  seenDeliveries: string[]
  lastRunAt?: number | undefined
  lastCreatedThreadId?: string | undefined
}

export interface BranchCiAutomationInput {
  id?: string
  name: string
  branch: string
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
}

export interface AutomationTriggerEvent {
  projectId: string
  scheduleId: string
  threadId: string
  triggeredAt: number
  /** Whether this trigger started a turn or found the schedule's prior turn still active. */
  disposition: 'started' | 'coalesced'
  /** Why a fresh task could not safely start. Present only when coalesced. */
  coalescedReason?: 'busy' | 'worktree-limit'
}
