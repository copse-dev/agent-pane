import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  approvalRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'

export interface ApprovalRequest {
  title: string
  body: string
  type: 'shell' | 'mcp'
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
  ipcMain.handle('approval:respond', (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, approved, remember] = parseIpcArgs(approvalRespondSchema, rawArgs)
      pending.get(id)?.({ approved, remember: remember === true })
      pending.delete(id)
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })
}

export function requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
  if (!mainWindow) return Promise.resolve({ approved: false, remember: false })
  const id = randomUUID()
  mainWindow.webContents.send('agent:approval_request', { id, ...req })
  return new Promise((resolve) => pending.set(id, resolve))
}
