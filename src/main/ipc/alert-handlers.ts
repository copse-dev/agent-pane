import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zThreadId } from './ipc-guards.ts'
import { createElectronUserAlertSender } from '../services/user-alerts-electron.ts'
import type { UserAlertSender } from '../services/user-alerts.ts'
import { getFocusedMainWindow, getMainWindowForWebContents } from '../windows/create-main-window.ts'

export function registerAlertHandlers(win: BrowserWindow, alertUser: UserAlertSender): void {
  ipcMain.handle('alerts:thread-finished', (event, rawThreadId: unknown, rawTitle: unknown) => {
    assertMainFrameSender(event, win)
    const [threadId, title] = parseIpcArgs(
      z.tuple([zThreadId, z.string().trim().min(1).max(512)]),
      [rawThreadId, rawTitle],
    )
    // The window that reported the finish owns the alert, so clicking its
    // notification opens the thread there. A pop-out is not a main window and
    // falls back to the one this handler was registered with.
    const owner = getMainWindowForWebContents(event.sender)
    const alert =
      owner && owner !== win
        ? createElectronUserAlertSender(owner, app.dock, getFocusedMainWindow)
        : alertUser
    alert('thread-finished', `${title} is ready.`, threadId)
  })
}
