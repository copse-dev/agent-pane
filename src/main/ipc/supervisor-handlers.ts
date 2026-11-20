import type { BrowserWindow } from 'electron'
import { peekBackgroundProcessLogs } from '../services/exec/background-process.ts'
import { defineHandler } from './define-handler.ts'
import {
  backgroundTaskLogsArgs,
  supervisorCancelArgs,
  supervisorListArgs,
  supervisorTaskArgs,
} from './supervisor-handler-args.ts'
import { getTaskSupervisor } from '../services/supervisor/task-supervisor.ts'
import { createSupervisedTaskClient } from '../services/supervisor/task-client.ts'

export function registerSupervisorHandlers(win: BrowserWindow): void {
  defineHandler(win, 'supervisor:list', supervisorListArgs, async (projectId) => {
    const supervisor = getTaskSupervisor()
    await supervisor.start()
    // The trusted desktop owns a project overview, including orphaned threads.
    // Individual clients still receive a bound thread scope, just like headless hosts.
    const owners = new Set(supervisor.list(projectId).map((task) => task.threadId))
    const results = await Promise.all(
      [...owners].map((threadId) =>
        createSupervisedTaskClient(supervisor, { projectId, threadId }).list(),
      ),
    )
    const tasks = results
      .flatMap((result) => result.tasks)
      .filter((task) => task.state !== 'completed' && task.state !== 'cancelled')
    return { tasks }
  })
  defineHandler(
    win,
    'supervisor:cancel',
    supervisorCancelArgs,
    async (projectId, taskId) => {
      const supervisor = getTaskSupervisor()
      await supervisor.start()
      const task = supervisor.get(projectId, taskId)
      if (!task) return { task: null }
      return createSupervisedTaskClient(supervisor, task).cancel(taskId)
    },
    { errors: 'per-argument' },
  )
  defineHandler(
    win,
    'supervisor:get',
    supervisorTaskArgs,
    (projectId, threadId, taskId) =>
      createSupervisedTaskClient(getTaskSupervisor(), { projectId, threadId }).get(taskId),
    { errors: 'per-argument' },
  )
  // A command card's "Logs" (#3956): one task's retained output, scoped to the
  // thread that started it. Reading here is not the agent observing the exit.
  defineHandler(
    win,
    'background-tasks:logs',
    backgroundTaskLogsArgs,
    (projectId, threadId, taskId) => peekBackgroundProcessLogs(taskId, { projectId, threadId }),
  )
  defineHandler(
    win,
    'supervisor:resume',
    supervisorTaskArgs,
    (projectId, threadId, taskId) =>
      createSupervisedTaskClient(getTaskSupervisor(), { projectId, threadId }).resume(taskId),
    { errors: 'per-argument' },
  )
}
