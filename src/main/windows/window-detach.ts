/**
 * Closing the window while a turn is running detaches it instead of quitting.
 *
 * Main writes a dispatched turn's transcript itself
 * (`services/turn-transcript-writer.ts`), so the window is no longer needed for
 * a turn to finish and be kept. On macOS, where an app outliving its last
 * window is the platform convention and the Dock is the way back, a close that
 * would otherwise end the run hides the window and unloads its renderer: the
 * page is torn down exactly as on a real close, but the `BrowserWindow` — which
 * every boot-time service still addresses — survives. Clicking the Dock icon or
 * launching Copse again loads a fresh renderer, which reads the transcript back
 * from disk.
 *
 * Elsewhere closing the last window still quits (after the usual confirmation);
 * those platforms have no equivalent of the Dock to come back through.
 *
 * On attachment, main supplies transcript/reducer checkpoints and replays
 * pending approvals and questions with their original request ids.
 */
import type { BrowserWindow } from 'electron'

export interface DetachDecisionInput {
  platform: NodeJS.Platform
  /** The close is part of quitting the app (or an e2e teardown). */
  quitting: boolean
  /** Turns running in this process right now. */
  runningTurns: number
}

/** Whether a close of the primary window should detach it rather than close it. */
export function shouldDetachOnClose(input: DetachDecisionInput): boolean {
  return input.platform === 'darwin' && !input.quitting && input.runningTurns > 0
}

type DetachableWindow = Pick<
  BrowserWindow,
  'hide' | 'show' | 'focus' | 'isDestroyed' | 'isMinimized' | 'restore'
> & {
  webContents: Pick<BrowserWindow['webContents'], 'loadURL'>
}

const detachedWindows = new WeakSet<object>()

/** Hide the window and unload its renderer; the runtime keeps going. */
export function detachWindow(win: DetachableWindow): void {
  if (win.isDestroyed() || detachedWindows.has(win)) return
  detachedWindows.add(win)
  win.hide()
  // Navigating away runs the page's own unload path (`pagehide` flushes the
  // autosave) and frees the renderer, as closing would.
  void win.webContents.loadURL('about:blank')
}

export function isWindowDetached(win: object): boolean {
  return detachedWindows.has(win)
}

/**
 * Bring a window back to the user: reload its renderer first if it was
 * detached, then show it. `loadRenderer` is the window's ordinary boot load.
 */
export function reattachWindow(
  win: DetachableWindow,
  loadRenderer: () => Promise<void>,
  options: { show: boolean } = { show: true },
): void {
  if (win.isDestroyed()) return
  if (detachedWindows.delete(win)) {
    loadRenderer().catch((error: unknown) => {
      console.error('[window] could not reload the window after it was detached:', error)
    })
  }
  if (!options.show) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
