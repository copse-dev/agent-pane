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
  type: 'shell' | 'mcp' | 'web'
  allowRemember?: boolean
  rememberLabel?: string
}

export interface ApprovalResponse {
  approved: boolean
  remember: boolean
}

// Pending approvals never auto-resolve, so a tool call would hang forever if the
// window is closed before the user answers. Bound the wait and deny on timeout.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Transport that actually asks for approval. The GUI registers a
 * BrowserWindow/IPC handler (see {@link initApproval}); a headless host (the ACP
 * agent) registers one that maps to its own permission channel. With no handler
 * set, approvals are denied rather than left hanging.
 */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResponse>

let handler: ApprovalHandler | null = null

export function setApprovalHandler(next: ApprovalHandler | null): void {
  handler = next
}

export function requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
  return handler ? handler(req) : Promise.resolve({ approved: false, remember: false })
}

export function initApproval(win: BrowserWindow): void {
  const pending = new Map<string, (response: ApprovalResponse) => void>()
  const settle = (id: string, response: ApprovalResponse): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(response)
  }

  ipcMain.handle('approval:respond', (event, ...rawArgs) => {
    try {
      // assertMainFrameSender rejects any frame other than the window's main
      // frame, so a compromised/embedded frame can't answer an approval.
      assertMainFrameSender(event, win)
      const [id, approved, remember] = parseIpcArgs(approvalRespondSchema, rawArgs)
      settle(id, { approved, remember: remember === true })
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  // If the window goes away, deny everything still pending so callers unblock.
  win.on('closed', () => {
    for (const [id] of pending) settle(id, { approved: false, remember: false })
  })

  setApprovalHandler(
    (req) =>
      new Promise<ApprovalResponse>((resolve) => {
        const id = randomUUID()
        win.webContents.send('agent:approval_request', { id, ...req })
        const timer = setTimeout(
          () => settle(id, { approved: false, remember: false }),
          APPROVAL_TIMEOUT_MS,
        )
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, (response) => {
          clearTimeout(timer)
          resolve(response)
        })
      }),
  )
}
