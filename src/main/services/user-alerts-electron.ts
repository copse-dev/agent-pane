import { app, Notification, shell, type BrowserWindow } from 'electron'
import { NeedsInputBadge } from './needs-input-badge.ts'
import { findThreadOwners } from './thread-store.ts'
import {
  dispatchUserAlert,
  readUserAlertPreferences,
  type UserAlertKind,
  type UserAlertSender,
} from './user-alerts.ts'

export interface DockAttention {
  bounce(type?: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

export interface WindowAttention {
  flashFrame(flag: boolean): void
  once(event: 'focus', listener: () => void): unknown
  removeListener(event: 'focus', listener: () => void): unknown
  isDestroyed(): boolean
}

export function shouldSendSystemNotification(
  win: Pick<BrowserWindow, 'isDestroyed' | 'isVisible'>,
): boolean {
  return !win.isDestroyed() && !win.isVisible()
}

/** Start the native attention animation and stop it on focus or explicit settlement. */
export function startWindowAttention(
  win: WindowAttention,
  dock: DockAttention | undefined,
  kind: UserAlertKind,
): () => void {
  let stopped = false
  let bounceId: number | null = null

  if (dock) {
    bounceId = dock.bounce(kind === 'interaction' ? 'critical' : 'informational')
  } else {
    win.flashFrame(true)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    win.removeListener('focus', stop)
    if (dock && bounceId !== null) dock.cancelBounce(bounceId)
    else if (!win.isDestroyed()) win.flashFrame(false)
  }
  win.once('focus', stop)
  return stop
}

/** Main → renderer: open a thread, because a notification about it was clicked. */
export const OPEN_THREAD_FROM_ALERT_CHANNEL = 'alerts:open-thread'

/** Payload of {@link OPEN_THREAD_FROM_ALERT_CHANNEL}. */
export interface OpenThreadFromAlert {
  threadId: string
  /** The thread's project from the thread store, or null when it has no single owner on disk. */
  projectId: string | null
}

export interface AlertClickWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** The one project whose store holds `threadId`, or null when none or several do. */
async function findThreadProjectId(threadId: string): Promise<string | null> {
  const owners = await findThreadOwners(threadId)
  return owners.length === 1 ? (owners[0] ?? null) : null
}

/**
 * Handle a click on an alert's system notification: bring the alert's window
 * forward and, when the alert is about a thread, have that window open it.
 *
 * The owner is the window the alert was raised for — the one whose renderer
 * holds the pending prompt, or that reported the finished thread. It is not
 * chosen by project: a prompt lives only in the renderer it was sent to, so
 * opening its thread in another window would show the thread without it. If
 * the owner has closed since, the most recently focused main window opens the
 * thread instead. Resolves to the window used, or null when none is left.
 *
 * The thread's project comes from the thread store rather than the renderer's
 * memory, so a finished thread still opens after the user has moved to another
 * project; the renderer falls back to its own lists when the lookup has none.
 */
export async function openUserAlertTarget<TWindow extends AlertClickWindow>(
  owner: TWindow,
  fallback: () => TWindow | null,
  threadId: string | undefined,
  findProjectId: (threadId: string) => Promise<string | null> = findThreadProjectId,
): Promise<TWindow | null> {
  const target = owner.isDestroyed() ? fallback() : owner
  if (!target || target.isDestroyed()) return null
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.focus()
  if (threadId === undefined) return target
  const projectId = await findProjectId(threadId).catch(() => null)
  if (target.isDestroyed()) return null
  const payload: OpenThreadFromAlert = { threadId, projectId }
  target.webContents.send(OPEN_THREAD_FROM_ALERT_CHANNEL, payload)
  return target
}

function applyAppBadgeCount(count: number): void {
  // macOS shows this on the Dock icon; Linux on launchers implementing the
  // LauncherEntry D-Bus API (elsewhere Electron returns false and nothing
  // shows). Windows has no numeric app badge — `setOverlayIcon` would need an
  // image rendered per count — so it is skipped there; the taskbar flash from
  // startWindowAttention still marks a waiting prompt.
  if (process.platform === 'win32') return
  app.setBadgeCount(count)
}

// One badge per app, shared by every window's alert sender.
let needsInputBadge: NeedsInputBadge | null = null

function getNeedsInputBadge(): NeedsInputBadge {
  needsInputBadge ??= new NeedsInputBadge(
    applyAppBadgeCount,
    () => readUserAlertPreferences().interaction,
  )
  return needsInputBadge
}

/** Re-apply the badge after the needs-input alert preference changes. */
export function refreshNeedsInputBadge(): void {
  needsInputBadge?.refresh()
}

// A notification collected by the garbage collector stops delivering `click`
// on macOS, so keep each one reachable until it is clicked or dismissed.
const liveNotifications = new Set<Notification>()

/**
 * Bind the pure alert policy to Electron's notification, sound, badge and
 * window APIs. `win` owns the alerts this sender raises; `fallbackWindow`
 * receives a notification click once `win` has closed.
 */
export function createElectronUserAlertSender(
  win: BrowserWindow,
  dock: DockAttention | undefined,
  fallbackWindow: () => BrowserWindow | null,
): UserAlertSender {
  return (kind, body, threadId) => {
    const stopAlert = dispatchUserAlert(readUserAlertPreferences(), kind, body, {
      notification: (title, notificationBody) => {
        if (!shouldSendSystemNotification(win) || !Notification.isSupported()) return
        const notification = new Notification({ title, body: notificationBody, silent: true })
        const forget = (): void => {
          liveNotifications.delete(notification)
        }
        notification.on('click', () => {
          forget()
          void openUserAlertTarget(win, fallbackWindow, threadId).catch((error: unknown) => {
            console.warn('[alerts] could not open the notification thread:', error)
          })
        })
        notification.on('close', forget)
        notification.on('failed', forget)
        liveNotifications.add(notification)
        notification.show()
      },
      sound: () => {
        shell.beep()
      },
      bounce: (alertKind) => startWindowAttention(win, dock, alertKind),
    })
    if (kind !== 'interaction') return stopAlert
    // Every prompt runs its alert's stop when it settles, so the badge hold
    // shares that lifetime (see needs-input-badge.ts).
    const release = getNeedsInputBadge().hold(threadId)
    return () => {
      release()
      stopAlert()
    }
  }
}
