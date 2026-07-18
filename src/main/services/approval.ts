import type { BrowserWindow } from 'electron'
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  approvalRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'
import { getActiveRunThread } from './thread-models.ts'

/** Model ids for a two-reviewer + judge comparison run. */
export interface ComparisonModelSelection {
  a: string
  b: string
  judge: string
}

export interface ApprovalRequest {
  title: string
  body: string
  type: 'shell' | 'mcp' | 'web' | 'pii' | 'model-compare' | 'review-spend'
  allowRemember?: boolean
  rememberLabel?: string
  /** Initial reviewer/judge ids when `type === 'model-compare'` (renderer shows pickers). */
  comparisonModels?: ComparisonModelSelection
}

export interface ApprovalResponse {
  approved: boolean
  remember: boolean
  /** User-selected models from the comparison approval pickers. */
  comparisonModels?: ComparisonModelSelection
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

/**
 * The slice of Electron's macOS `app.dock` we use to draw attention while an
 * approval is pending. Structural so the real `Dock` satisfies it and tests can
 * pass a fake without pulling in Electron.
 */
export interface DockAttention {
  bounce(type?: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/**
 * Bounce the dock icon ('critical' keeps bouncing until the app is focused) to
 * signal a pending approval, returning a stop function to call once it settles.
 * No-op when there's no dock (non-macOS / headless), so callers need no guards.
 */
export function startDockAttention(dock: DockAttention | undefined): () => void {
  if (!dock) return () => {}
  const id = dock.bounce('critical')
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    dock.cancelBounce(id)
  }
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
      const [id, approved, remember, comparisonModels] = parseIpcArgs(
        approvalRespondSchema,
        rawArgs,
      )
      settle(id, {
        approved,
        remember: remember === true,
        ...(comparisonModels ? { comparisonModels } : {}),
      })
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
        // Attribute the request to the thread whose run triggered it so the
        // renderer can scope the prompt to that thread — a background thread's
        // approval must not pop a modal over whichever project is focused, it
        // shows a sidebar attention indicator instead (issue: cross-project
        // prompt leakage). Null when no run owns it (e.g. headless paths).
        const threadId = getActiveRunThread() ?? undefined
        win.webContents.send('agent:approval_request', { id, threadId, ...req })
        // Bounce the dock until the user returns to answer (macOS only; app.dock
        // is undefined elsewhere). macOS auto-stops the bounce on focus, and we
        // also stop it when the approval settles for any reason.
        const stopDockAttention = startDockAttention(app.dock)
        const timer = setTimeout(() => {
          settle(id, { approved: false, remember: false })
        }, APPROVAL_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, (response) => {
          clearTimeout(timer)
          stopDockAttention()
          resolve(response)
        })
      }),
  )
}
