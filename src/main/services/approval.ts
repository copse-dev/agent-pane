import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

export interface ApprovalRequest {
  title: string
  body: string
  type: 'shell' | 'mcp'
  /** Show an "always allow" checkbox (used for MCP tools). */
  allowRemember?: boolean
}

export interface ApprovalResponse {
  approved: boolean
  remember: boolean
}

const pending = new Map<string, (response: ApprovalResponse) => void>()
let mainWindow: BrowserWindow | null = null

export function initApproval(win: BrowserWindow): void {
  mainWindow = win
  ipcMain.handle('approval:respond', (_e, id: string, approved: boolean, remember?: boolean) => {
    pending.get(id)?.({ approved, remember: remember === true })
    pending.delete(id)
  })
}

export function requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
  if (!mainWindow) return Promise.resolve({ approved: false, remember: false })
  const id = randomUUID()
  mainWindow.webContents.send('agent:approval_request', { id, ...req })
  return new Promise((resolve) => pending.set(id, resolve))
}
