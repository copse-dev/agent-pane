import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

export interface ApprovalRequest {
  title: string
  body: string
  type: 'shell' | 'mcp'
}

const pending = new Map<string, (approved: boolean) => void>()
let mainWindow: BrowserWindow | null = null

export function initApproval(win: BrowserWindow): void {
  mainWindow = win
  ipcMain.handle('approval:respond', (_e, id: string, approved: boolean) => {
    pending.get(id)?.(approved)
    pending.delete(id)
  })
}

export function requestApproval(req: ApprovalRequest): Promise<boolean> {
  if (!mainWindow) return Promise.resolve(false)
  const id = randomUUID()
  mainWindow.webContents.send('agent:approval_request', { id, ...req })
  return new Promise((resolve) => pending.set(id, resolve))
}
