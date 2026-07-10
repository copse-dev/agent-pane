import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ensureTerminalPermitted } from '../services/security/permission-gate.ts'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zSessionId } from './ipc-guards.ts'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from '../services/exec/terminal-service.ts'

const zCols = z.number().int().min(1).max(500)
const zRows = z.number().int().min(1).max(200)
const terminalDimsSchema = z.tuple([zCols, zRows])
// A trailing optional flag requesting an unsandboxed shell; the gate decides
// whether to grant it (issue #662). Absent/false ⇒ confined terminal.
const terminalCreateSchema = z.tuple([zCols, zRows, z.boolean().optional()])

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [cols, rows, requestUnsandboxed = false] = parseIpcArgs(terminalCreateSchema, rawArgs)
    const { permitted, unsandboxed } = await ensureTerminalPermitted(requestUnsandboxed)
    if (!permitted) throw new Error('Terminal access was not approved')
    return createTerminalSession(win, event.sender.id, cols, rows, unsandboxed)
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
    const [c, r] = parseIpcArgs(terminalDimsSchema, [cols, rows])
    resizeTerminalSession(id, event.sender.id, c, r)
  })

  ipcMain.handle('terminal:destroy', (event, sessionId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    destroyTerminalSession(id, event.sender.id)
  })

  const onWindowClose = (): void => {
    destroyAllTerminalSessions()
  }
  win.on('close', onWindowClose)

  return () => {
    win.off('close', onWindowClose)
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeHandler('terminal:write')
    ipcMain.removeHandler('terminal:resize')
    ipcMain.removeHandler('terminal:destroy')
    destroyAllTerminalSessions()
  }
}
