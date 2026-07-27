/** A project-owned recurring schedule persisted by the automations pack. */
export interface AutomationSchedule {
  id: string
  projectId: string
  name: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
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
}

export interface AutomationTriggerEvent {
  projectId: string
  scheduleId: string
  threadId: string
  triggeredAt: number
}
