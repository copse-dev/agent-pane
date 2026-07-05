import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zSessionId } from './ipc-guards.ts'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  resizeBackgroundProcess,
  setBackgroundEventSink,
  stopBackgroundProcess,
  writeBackgroundProcess,
} from '../services/exec/background-process.ts'

const sizeSchema = z.tuple([z.number().int().min(1).max(500), z.number().int().min(1).max(200)])

/**
 * IPC for the renderer to drive agent-started background tasks (issue #691).
 * These act on tasks the agent already started under a per-workspace grant, so
 * they need no further approval — the user is interacting with an existing
 * session (typing, resizing, reading logs, stopping), not launching anything.
 */
export function initBackground(win: BrowserWindow): () => void {
  // Route service events (started/data/url/exit) to this window's renderer.
  setBackgroundEventSink((channel, ...args) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, ...args)
  })

  ipcMain.handle('background:list', (event) => {
    assertMainFrameSender(event, win)
    return listBackgroundProcesses()
  })

  ipcMain.handle('background:logs', (event, id: unknown) => {
    assertMainFrameSender(event, win)
    return getBackgroundProcessLogs(parseIpcArgs(zSessionId, [id]))
  })

  ipcMain.handle('background:write', (event, id: unknown, data: unknown) => {
    assertMainFrameSender(event, win)
    writeBackgroundProcess(
      parseIpcArgs(zSessionId, [id]),
      parseIpcArgs(z.string().max(65536), [data]),
    )
  })

  ipcMain.handle('background:resize', (event, id: unknown, cols: unknown, rows: unknown) => {
    assertMainFrameSender(event, win)
    const [c, r] = parseIpcArgs(sizeSchema, [cols, rows])
    resizeBackgroundProcess(parseIpcArgs(zSessionId, [id]), c, r)
  })

  ipcMain.handle('background:stop', (event, id: unknown) => {
    assertMainFrameSender(event, win)
    return stopBackgroundProcess(parseIpcArgs(zSessionId, [id]))
  })

  return () => {
    setBackgroundEventSink(null)
    ipcMain.removeHandler('background:list')
    ipcMain.removeHandler('background:logs')
    ipcMain.removeHandler('background:write')
    ipcMain.removeHandler('background:resize')
    ipcMain.removeHandler('background:stop')
  }
}
