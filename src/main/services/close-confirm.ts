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
import { isWindowDetached } from '../windows/window-detach.ts'
import { getSetting } from './storage/settings.ts'
import { continuesTurnsAfterQuit } from './turn-worker/turn-worker-launch.ts'

/**
 * Guards closing the app while an agent is still working.
 *
 * Quitting is destructive to a live turn: `cleanupBeforeQuit` disposes every ACP
 * session, terminal and background process, and whatever the agent had not yet
 * written to disk is gone. Unless the quit hands its turns to background workers
 * ("Continue turns after Copse closes"), a quit the user chose is also not
 * continued on the next launch (`last-run.ts`); only a crash or an update
 * relaunch is. So the close is checked with
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

// Set when the close was let through with nobody's answer: the renderer went
// away or never replied. Cleared by a real answer.
let unanswered = false

/**
 * Whether the close going ahead was let through unanswered rather than
 * confirmed. Nobody chose such a quit, so like a signal it must not hand its
 * turns to workers.
 */
export function closeWentUnanswered(): boolean {
  return unanswered
}

// Whether a quit now would hand every working turn to a worker. Until the app
// wires it, only the setting is known.
let quitHandsEveryTurnOff: () => Promise<boolean> = () =>
  Promise.resolve(continuesTurnsAfterQuit(getSetting))

/**
 * How the question learns whether closing keeps the working turns going: the
 * setting, and whether a worker can run each of them (`workerCannotRun`). A
 * turn the worker turns down waits for the next launch, so the dialog must not
 * promise it keeps going.
 */
export function setQuitHandOffCheck(check: () => Promise<boolean>): void {
  quitHandsEveryTurnOff = check
}

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

export function isCloseApproved(): boolean {
  return gate.isApproved()
}

/** Ask again on the next close: the quit `approveClose` was for did not happen. */
export function revokeCloseApproval(): void {
  gate.revoke()
}

/**
 * Decide whether a close should detach the window rather than close it.
 * `rendererGone` is true when the renderer has crashed, so the window cannot
 * keep it running in the background.
 */
export type DetachInstead = (options: { rendererGone: boolean }) => boolean

const detachers = new WeakMap<BrowserWindow, DetachInstead>()

/**
 * Intercept the window's own close (traffic light, Alt+F4, Cmd+W) and re-issue
 * it once confirmed. `before-quit` covers the quit routes; this covers the ones
 * that reach the window directly.
 */
export function guardWindowClose(win: BrowserWindow, detachInstead?: DetachInstead): void {
  if (detachInstead) detachers.set(win, detachInstead)
  win.on('close', (event) => {
    // A running turn no longer needs the window (main writes its transcript),
    // so the close detaches it and there is nothing to warn about.
    if (detachInstead?.({ rendererGone: false })) {
      event.preventDefault()
      return
    }
    gate.defer(event, () => {
      if (!win.isDestroyed()) win.close()
    })
  })
}

/**
 * Close a window whose renderer has crashed. It cannot go through `close()`:
 * the confirmation asks the renderer, which never answers. It still honours the
 * window's detach rule, which reads only main-process state, so a turn running
 * in the main process keeps going with the window hidden instead of the last
 * window's destruction quitting the app and stopping it.
 */
export function closeCrashedWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (detachers.get(win)?.({ rendererGone: true })) return
  win.destroy()
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
      if (pending.has(id)) unanswered = false
      settle(id, confirmed)
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  // Fail open, but as a quit nobody answered.
  const release = (id: string): void => {
    if (!pending.has(id)) return
    unanswered = true
    settle(id, true)
  }
  const releaseAll = (): void => {
    for (const id of [...pending.keys()]) release(id)
  }

  // A renderer that is gone can no longer refuse; release every waiter so the
  // close it was blocking completes.
  win.on('closed', releaseAll)

  // The renderer can also die while the window object lives on, and then no
  // `closed` ever arrives. That is the normal shape of a terminal hangup: the
  // SIGHUP that starts the quit kills the renderer milliseconds later, so the
  // question `before-quit` just asked can never be answered and the quit sat
  // out the full two-minute timeout with the app pinned in the background
  // (issue #1911). Fails open, like every other path here.
  win.webContents.on('render-process-gone', releaseAll)

  requestConfirm = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      // A detached window has no page to ask. The quit still goes ahead, but
      // nobody answered it (the detach came from an earlier window close), so
      // it hands nothing off.
      if (win.isDestroyed() || isWindowDetached(win)) {
        unanswered = true
        resolve(true)
        return
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        release(id)
      }, CLOSE_CONFIRM_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, (confirmed) => {
        clearTimeout(timer)
        resolve(confirmed)
      })
      // Whether a quit now hands the working turns off instead of stopping them,
      // so the question can say what closing will do. A check that fails says
      // the cautious thing: closing stops them.
      void quitHandsEveryTurnOff()
        .catch(() => false)
        .then((continuesAfterQuit) => {
          if (!pending.has(id) || win.isDestroyed()) return
          win.webContents.send('app:close-confirm-request', { id, continuesAfterQuit })
        })
    })
}
