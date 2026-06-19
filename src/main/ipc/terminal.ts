import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from '../services/terminal-service.ts'

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', (_e, cols: number, rows: number) =>
    createTerminalSession(win, cols, rows),
  )

  ipcMain.handle('terminal:write', (_e, sessionId: string, data: string) => {
    writeTerminalSession(sessionId, data)
  })

  ipcMain.handle('terminal:resize', (_e, sessionId: string, cols: number, rows: number) => {
    resizeTerminalSession(sessionId, cols, rows)
  })

  ipcMain.handle('terminal:destroy', (_e, sessionId: string) => {
    destroyTerminalSession(sessionId)
  })

  return () => {
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeHandler('terminal:write')
    ipcMain.removeHandler('terminal:resize')
    ipcMain.removeHandler('terminal:destroy')
    destroyAllTerminalSessions()
  }
}
