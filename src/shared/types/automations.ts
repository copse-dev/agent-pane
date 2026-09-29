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
