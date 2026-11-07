import { networkActivity } from '../services/diagnostics/network-activity.ts'
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { stopSupervisedBackgroundProcess } from '../services/exec/supervised-background-process.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { getMainWindowForWebContents } from '../windows/create-main-window.ts'
import type { ProcessManagerSnapshot } from '@shared/types/process-manager.ts'

export function registerProcessManagerHandlers(
  win: BrowserWindow,
  processManagerSnapshot: () => Promise<ProcessManagerSnapshot>,
): void {
  ipcMain.handle('process-manager:snapshot', async (event) => {
    assertMainFrameSender(event, win)
    const snapshot = await processManagerSnapshot()
    return { ...snapshot, network: networkActivity.snapshot() }
  })

  ipcMain.handle('process-manager:stop-background', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    if (!getMainWindowForWebContents(event.sender)) {
      throw new IpcValidationError('Only a main window can stop a background task')
    }
    const [id, projectId, threadId] = parseIpcArgs(
      z.tuple([z.string().min(1).max(128), zProjectId, zThreadId]),
      rawArgs,
    )
    return stopSupervisedBackgroundProcess(id, { projectId, threadId })
  })
}
