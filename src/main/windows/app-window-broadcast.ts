/**
 * Every renderer this app owns: the main window plus any pane pop-out windows.
 *
 * Most main-process services capture one `BrowserWindow` at init and push
 * renderer events through it. That was correct while there was exactly one
 * renderer, but a pane pop-out (`create-popout-window.ts`) loads the *same*
 * renderer in a second window, so a main-window-only push leaves the detached
 * pane permanently out of date — the Changes pop-out never learned about the
 * proposed-diff queue at all (#1704).
 *
 * Services that push *shared workspace state* (the diff queue, file changes)
 * should broadcast here instead of targeting one window. Services that push a
 * *request awaiting one answer* (approvals, prompts, close confirmation) must
 * keep targeting a single window — fanning those out would raise the same
 * dialog several times.
 */
export interface AppWindowWebContents {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

const appWindows = new Set<AppWindowWebContents>()

/** Register a window's webContents. Returns its unregister function. */
export function registerAppWindow(webContents: AppWindowWebContents): () => void {
  appWindows.add(webContents)
  return () => {
    appWindows.delete(webContents)
  }
}

/**
 * Send to every live app window. Destroyed entries are dropped as they are
 * found: a window can be torn down between its `closed` handler and the next
 * push (and `closed` may not run at all during app shutdown).
 */
export function broadcastToAppWindows(channel: string, ...args: unknown[]): void {
  for (const webContents of [...appWindows]) {
    if (webContents.isDestroyed()) {
      appWindows.delete(webContents)
      continue
    }
    webContents.send(channel, ...args)
  }
}

/** @internal test helper — the number of live registered windows. */
export function appWindowCountForTest(): number {
  return appWindows.size
}

/** @internal test helper — reset registrations between tests. */
export function resetAppWindowsForTest(): void {
  appWindows.clear()
}
