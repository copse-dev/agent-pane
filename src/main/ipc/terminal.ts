import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  writeTerminalSession,
} from '../services/terminal-service.ts'

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', () => createTerminalSession(win))

  ipcMain.handle('terminal:write', (_e, sessionId: string, data: string) => {
    writeTerminalSession(sessionId, data)
  })

  ipcMain.handle('terminal:destroy', (_e, sessionId: string) => {
    destroyTerminalSession(sessionId)
  })

  return () => {
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeHandler('terminal:write')
    ipcMain.removeHandler('terminal:destroy')
    destroyAllTerminalSessions()
  }
}
