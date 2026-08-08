import type { TaskState } from '../supervisor/task-schema.ts'

export interface SupervisedTaskSummary {
  taskId: string
  projectId: string
  threadId: string
  handler: string
  state: TaskState
  updatedAt: number
}
