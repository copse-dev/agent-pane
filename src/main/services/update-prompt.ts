import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  updatePromptRespondSchema,
} from '../ipc/ipc-guards.ts'

export interface UpdatePromptRequest {
  message: string
  detail?: string
  buttons: [string, ...string[]]
  defaultIndex?: number
  cancelIndex?: number
}

const UPDATE_PROMPT_TIMEOUT_MS = 5 * 60_000

let requestPrompt: ((req: UpdatePromptRequest) => Promise<number>) | null = null

/** Show an in-app update prompt; returns the chosen button index. */
export function requestUpdatePrompt(req: UpdatePromptRequest): Promise<number> {
  if (!requestPrompt) {
    return Promise.resolve(req.cancelIndex ?? req.buttons.length - 1)
  }
  return requestPrompt(req)
}

/** Dev/e2e "Check for Updates…" when no feed exists — toast in the renderer. */
export function notifyUpdateDevOnly(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('update:dev_notice')
}

export function initUpdatePrompt(win: BrowserWindow): void {
  const pending = new Map<string, (buttonIndex: number) => void>()
  const settle = (id: string, buttonIndex: number): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(buttonIndex)
  }

  ipcMain.handle('update-prompt:respond', (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, buttonIndex] = parseIpcArgs(updatePromptRespondSchema, rawArgs)
      settle(id, buttonIndex)
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  win.on('closed', () => {
    for (const [id, req] of pending) {
      pending.delete(id)
      req(-1)
    }
  })

  requestPrompt = (req: UpdatePromptRequest): Promise<number> =>
    new Promise<number>((resolve) => {
      const id = randomUUID()
      win.webContents.send('update:prompt_request', {
        id,
        message: req.message,
        detail: req.detail,
        buttons: req.buttons,
        defaultIndex: req.defaultIndex,
        cancelIndex: req.cancelIndex,
      })
      const timer = setTimeout(() => {
        settle(id, req.cancelIndex ?? req.buttons.length - 1)
      }, UPDATE_PROMPT_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, (buttonIndex) => {
        clearTimeout(timer)
        resolve(buttonIndex)
      })
    })
}
