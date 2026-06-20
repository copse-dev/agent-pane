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

// Pending approvals never auto-resolve, so a tool call would hang forever if the
// window is closed before the user answers. Bound the wait and deny on timeout.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

const pending = new Map<string, (response: ApprovalResponse) => void>()
let mainWindow: BrowserWindow | null = null

function settle(id: string, response: ApprovalResponse): void {
  const resolve = pending.get(id)
  if (!resolve) return
  pending.delete(id)
  resolve(response)
}

export function initApproval(win: BrowserWindow): void {
  mainWindow = win
  ipcMain.handle('approval:respond', (e, id: string, approved: boolean, remember?: boolean) => {
    // Only the app's own top frame may answer an approval — otherwise a
    // compromised/embedded frame could auto-approve (or set `remember`) for any
    // pending id it can guess.
    if (e.senderFrame !== win.webContents.mainFrame) return
    settle(id, { approved, remember: remember === true })
  })

  // If the window goes away, deny everything still pending so callers unblock.
  win.on('closed', () => {
    for (const [id] of pending) settle(id, { approved: false, remember: false })
  })
}

export function requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
  if (!mainWindow) return Promise.resolve({ approved: false, remember: false })
  const id = randomUUID()
  mainWindow.webContents.send('agent:approval_request', { id, ...req })
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => settle(id, { approved: false, remember: false }),
      APPROVAL_TIMEOUT_MS,
    )
    if (typeof timer.unref === 'function') timer.unref()
    pending.set(id, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
  })
}
