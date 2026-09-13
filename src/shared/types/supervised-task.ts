import type { TaskState, TaskTrigger, TaskResultRef } from '../supervisor/task-schema.ts'

export interface SupervisedTaskSummary {
  taskId: string
  projectId: string
  threadId: string
  handler: string
  state: TaskState
  updatedAt: number
  lastError?: string
  attempt?: number
  maxAttempts?: number
  trigger?: TaskTrigger
  retryAt?: number
  resultRef?: TaskResultRef
}
