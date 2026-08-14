import type { BrowserWindow } from 'electron'
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  assertMainFrameSender,
  closeConfirmRespondSchema,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'
import { createCloseGate } from './close-gate.ts'

/**
 * Guards closing the app while an agent is still working.
 *
 * Quitting is destructive to a live turn: `cleanupBeforeQuit` disposes every ACP
 * session, terminal and background process, and a run has no resume — whatever
 * the agent had not yet written to disk is gone. So the close is checked with
 * the user *before* teardown starts, on both routes out of the app (the window's
 * own close, and `before-quit` from Cmd+Q / the menu / the updater).
 *
 * The renderer answers the question rather than main: it already holds thread
 * statuses and the in-app confirm dialog, so asking it keeps this from having to
 * mirror thread state into main and keeps the prompt in Copse's own UI instead
 * of a native message box.
 *
 * Every failure mode here fails **open**. A destroyed renderer, an unregistered
 * handler or a renderer that never answers must never be able to trap the user
 * in an app they cannot close.
 */

// Generous: the user may be reading the dialog, or away from the keyboard. Only
// a renderer that has stopped answering entirely should hit this.
const CLOSE_CONFIRM_TIMEOUT_MS = 2 * 60_000

let requestConfirm: (() => Promise<boolean>) | null = null

// Before the renderer is wired up there is nobody to object, so the gate asks a
// question that answers itself.
const gate = createCloseGate({
  requestConfirmation: () => requestConfirm?.() ?? Promise.resolve(true),
})

/**
 * Ask the renderer whether the app may close. Resolves `true` when there is
 * nothing to warn about (the common case — the renderer answers immediately) or
 * when the user confirmed anyway.
 */
export function requestCloseConfirmation(): Promise<boolean> {
  if (gate.isApproved()) return Promise.resolve(true)
  return requestConfirm?.() ?? Promise.resolve(true)
}

/**
 * Let the next close through without asking. Used for quits nobody is present to
 * answer, such as SIGINT/SIGTERM.
 */
export function approveClose(): void {
  gate.approve()
}

/**
 * Intercept the window's own close (traffic light, Alt+F4, Cmd+W) and re-issue
 * it once confirmed. `before-quit` covers the quit routes; this covers the ones
 * that reach the window directly.
 */
export function guardWindowClose(win: BrowserWindow): void {
  win.on('close', (event) => {
    gate.defer(event, () => {
      if (!win.isDestroyed()) win.close()
    })
  })
}

/**
 * Intercept `before-quit` ahead of the teardown that would kill the running
 * turns we are warning about. Returns `true` when the caller should stop and let
 * the confirmation run; `false` when the quit may proceed.
 */
export function deferQuitForCloseConfirmation(event: { preventDefault: () => void }): boolean {
  return gate.defer(event, () => {
    app.quit()
  })
}

export function initCloseConfirm(win: BrowserWindow): void {
  const pending = new Map<string, (confirmed: boolean) => void>()
  const settle = (id: string, confirmed: boolean): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(confirmed)
  }

  ipcMain.handle('close-confirm:respond', (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, confirmed] = parseIpcArgs(closeConfirmRespondSchema, rawArgs)
      settle(id, confirmed)
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  // A renderer that is gone can no longer refuse; release every waiter so the
  // close it was blocking completes.
  win.on('closed', () => {
    for (const id of [...pending.keys()]) settle(id, true)
  })

  requestConfirm = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (win.isDestroyed()) {
        resolve(true)
        return
      }
      const id = randomUUID()
      win.webContents.send('app:close_confirm_request', { id })
      const timer = setTimeout(() => {
        settle(id, true)
      }, CLOSE_CONFIRM_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, (confirmed) => {
        clearTimeout(timer)
        resolve(confirmed)
      })
    })
}
