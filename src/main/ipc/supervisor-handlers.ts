import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { peekBackgroundProcessLogs } from '../services/exec/background-process.ts'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zNonEmptyString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { getTaskSupervisor } from '../services/supervisor/task-supervisor.ts'
import { createSupervisedTaskClient } from '../services/supervisor/task-client.ts'

export function registerSupervisorHandlers(win: BrowserWindow): void {
  ipcMain.handle('supervisor:list', async (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zNonEmptyString.max(256), [rawProjectId])
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
  ipcMain.handle('supervisor:cancel', async (event, rawProjectId: unknown, rawTaskId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zNonEmptyString.max(256), [rawProjectId])
    const taskId = parseIpcArgs(zNonEmptyString.max(256), [rawTaskId])
    const supervisor = getTaskSupervisor()
    await supervisor.start()
    const task = supervisor.get(projectId, taskId)
    if (!task) return { task: null }
    return createSupervisedTaskClient(supervisor, task).cancel(taskId)
  })
  ipcMain.handle(
    'supervisor:get',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawTaskId: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zNonEmptyString.max(256), [rawProjectId])
      const threadId = parseIpcArgs(zNonEmptyString.max(256), [rawThreadId])
      const taskId = parseIpcArgs(zNonEmptyString.max(256), [rawTaskId])
      return createSupervisedTaskClient(getTaskSupervisor(), { projectId, threadId }).get(taskId)
    },
  )
  // A command card's "Logs" (#3956): one task's retained output, scoped to the
  // thread that started it. Reading here is not the agent observing the exit.
  ipcMain.handle(
    'background-tasks:logs',
    (event, rawProjectId: unknown, rawThreadId: unknown, rawTaskId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, taskId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zNonEmptyString.max(256)]),
        [rawProjectId, rawThreadId, rawTaskId],
      )
      return peekBackgroundProcessLogs(taskId, { projectId, threadId })
    },
  )
  ipcMain.handle(
    'supervisor:resume',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawTaskId: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zNonEmptyString.max(256), [rawProjectId])
      const threadId = parseIpcArgs(zNonEmptyString.max(256), [rawThreadId])
      const taskId = parseIpcArgs(zNonEmptyString.max(256), [rawTaskId])
      return createSupervisedTaskClient(getTaskSupervisor(), { projectId, threadId }).resume(taskId)
    },
  )
}
