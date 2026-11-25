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
 * Linux and Windows detach the same way while a turn runs: a close there used to
 * quit, and quitting kills the turn. Those platforms have no Dock to come back
 * through, so launching Copse again is the way back (`second-instance`), and a
 * detached app with nothing left running quits on its own
 * ({@link shouldQuitDetachedApp}) instead of lingering as an invisible process.
 *
 * While Mobile Companion is enabled, closing on any platform retains the hidden
 * renderer: it still owns human submissions, the queue and remote read relays.
 * Explicit Quit still stops the app; a sleeping host cannot serve phones.
 *
 * With no turn running and no phone attached, closing the last window outside
 * macOS still quits (after the usual confirmation).
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
  /** Mobile chat still needs the primary renderer for submissions, queues and reads. */
  mobileCompanionEnabled?: boolean
}

/** Whether a close of the primary window should detach it rather than close it. */
export function shouldDetachOnClose(input: DetachDecisionInput): boolean {
  return !input.quitting && (input.mobileCompanionEnabled === true || input.runningTurns > 0)
}

export interface DetachedIdleInput {
  platform: NodeJS.Platform
  /** The primary window is detached (hidden after a close mid-turn). */
  detached: boolean
  /** Turns running in this process right now. */
  runningTurns: number
  /** Mobile chat still needs the app running to serve the phone. */
  mobileCompanionEnabled: boolean
}

/**
 * Whether an app kept alive only to finish its turns should now quit.
 *
 * macOS keeps the app in the Dock by convention, so it never quits here. Elsewhere
 * the detached app is invisible, so once its last turn ends, and no phone still
 * needs it, it finishes the close the user asked for.
 */
export function shouldQuitDetachedApp(input: DetachedIdleInput): boolean {
  return (
    input.platform !== 'darwin' &&
    input.detached &&
    input.runningTurns === 0 &&
    !input.mobileCompanionEnabled
  )
}

type DetachableWindow = Pick<
  BrowserWindow,
  'hide' | 'show' | 'focus' | 'isDestroyed' | 'isMinimized' | 'restore'
> & {
  webContents: Pick<BrowserWindow['webContents'], 'loadURL' | 'setBackgroundThrottling'>
}

const detachedWindows = new WeakMap<object, { keepRenderer: boolean }>()

/** Hide the window and unload its renderer; the runtime keeps going. */
export function detachWindow(
  win: DetachableWindow,
  options: { keepRenderer: boolean } = { keepRenderer: false },
): void {
  if (win.isDestroyed() || detachedWindows.has(win)) return
  detachedWindows.set(win, options)
  win.hide()
  if (options.keepRenderer) {
    // Mobile submissions and live snapshots use this renderer. Keep its timers
    // responsive while hidden; there is still exactly one queue/transcript owner.
    win.webContents.setBackgroundThrottling(false)
    return
  }
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
  const detached = detachedWindows.get(win)
  detachedWindows.delete(win)
  if (detached?.keepRenderer) win.webContents.setBackgroundThrottling(true)
  if (detached && !detached.keepRenderer) {
    loadRenderer().catch((error: unknown) => {
      console.error('[window] could not reload the window after it was detached:', error)
    })
  }
  if (!options.show) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
