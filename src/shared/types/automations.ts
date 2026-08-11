/** A project-owned recurring schedule persisted by the automations plugin. */
export type AutomationLiveWorktreeLimit = 1 | 2 | 3

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
