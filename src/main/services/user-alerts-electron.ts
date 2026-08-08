import { Notification, shell, type BrowserWindow } from 'electron'
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

/** Bind the pure alert policy to Electron's notification, sound, and window APIs. */
export function createElectronUserAlertSender(
  win: BrowserWindow,
  dock: DockAttention | undefined,
): UserAlertSender {
  return (kind, body) =>
    dispatchUserAlert(readUserAlertPreferences(), kind, body, {
      notification: (title, notificationBody) => {
        if (!shouldSendSystemNotification(win) || !Notification.isSupported()) return
        const notification = new Notification({ title, body: notificationBody, silent: true })
        notification.on('click', () => {
          if (win.isDestroyed()) return
          if (!win.isVisible()) win.show()
          win.focus()
        })
        notification.show()
      },
      sound: () => {
        shell.beep()
      },
      bounce: (alertKind) => startWindowAttention(win, dock, alertKind),
    })
}
