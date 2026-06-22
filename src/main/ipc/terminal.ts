import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ensureTerminalPermitted } from '../services/permission-gate.ts'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zSessionId } from './ipc-guards.ts'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from '../services/terminal-service.ts'

const terminalCreateSchema = z.tuple([
  z.number().int().min(1).max(500),
  z.number().int().min(1).max(200),
])

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [cols, rows] = parseIpcArgs(terminalCreateSchema, rawArgs)
    const permitted = await ensureTerminalPermitted()
    if (!permitted) throw new Error('Terminal access was not approved')
    return createTerminalSession(win, event.sender.id, cols, rows)
  })

  ipcMain.handle('terminal:write', (event, sessionId: unknown, data: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    const payload = parseIpcArgs(z.string().max(65536), [data])
    writeTerminalSession(id, event.sender.id, payload)
  })

  ipcMain.handle('terminal:resize', (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    const [c, r] = parseIpcArgs(terminalCreateSchema, [cols, rows])
    resizeTerminalSession(id, event.sender.id, c, r)
  })

  ipcMain.handle('terminal:destroy', (event, sessionId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    destroyTerminalSession(id, event.sender.id)
  })

  return () => {
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeHandler('terminal:write')
    ipcMain.removeHandler('terminal:resize')
    ipcMain.removeHandler('terminal:destroy')
    destroyAllTerminalSessions()
  }
}
