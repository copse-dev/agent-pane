import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import type { SupervisedTaskSummary } from '@shared/types/supervised-task.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import type { TaskSupervisor } from './task-supervisor.ts'

function summary(task: SupervisedTaskMeta): SupervisedTaskSummary {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    threadId: task.threadId,
    handler: task.handler,
    state: task.state,
    updatedAt: task.updatedAt,
    attempt: task.attempt,
    maxAttempts: Math.min(task.maxAttempts, task.resourceBudget?.maxAttempts ?? task.maxAttempts),
    trigger: task.trigger,
    ...(task.lastError ? { lastError: task.lastError } : {}),
    ...(task.retryAt !== undefined ? { retryAt: task.retryAt } : {}),
    ...(task.resultRef ? { resultRef: task.resultRef } : {}),
  }
}

/**
 * Shared desktop/headless task operations. The host binds a trusted owner once;
 * client requests cannot supply a different project/thread or adopt foreign work.
 * No payloads or permission snapshots leave this inspection surface.
 */
export interface SupervisedTaskClient {
  list(): Promise<{ tasks: SupervisedTaskSummary[] }>
  get(taskId: string): Promise<{ task: SupervisedTaskSummary | null }>
  cancel(taskId: string): Promise<{ task: SupervisedTaskSummary | null }>
  resume(taskId: string): Promise<{ task: SupervisedTaskSummary | null }>
}

export function createSupervisedTaskClient(
  supervisor: TaskSupervisor,
  owner: ThreadExecutionOwner,
): SupervisedTaskClient {
  const { projectId, threadId } = owner
  const owned = async (taskId: string): Promise<SupervisedTaskMeta | null> => {
    await supervisor.start()
    const task = supervisor.get(projectId, taskId)
    return task?.threadId === threadId ? task : null
  }
  return {
    async list(): Promise<{ tasks: SupervisedTaskSummary[] }> {
      await supervisor.start()
      return {
        tasks: supervisor
          .list(projectId)
          .filter((task) => task.threadId === threadId)
          .map(summary),
      }
    },
    async get(taskId: string): Promise<{ task: SupervisedTaskSummary | null }> {
      const task = await owned(taskId)
      return { task: task ? summary(task) : null }
    },
    async cancel(taskId: string): Promise<{ task: SupervisedTaskSummary | null }> {
      if (!(await owned(taskId))) return { task: null }
      const task = await supervisor.cancel(projectId, taskId)
      return { task: task ? summary(task) : null }
    },
    async resume(taskId: string): Promise<{ task: SupervisedTaskSummary | null }> {
      if (!(await owned(taskId))) return { task: null }
      const task = await supervisor.retry(projectId, taskId)
      return { task: task ? summary(task) : null }
    },
  }
}
