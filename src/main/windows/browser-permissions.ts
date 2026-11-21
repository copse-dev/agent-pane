import type { Session } from 'electron'

export function isBrowserPermissionAllowed(_permission: string): boolean {
  return false
}

/** Install before creating guests; checks and requests must use the same policy. */
export function configureBrowserPermissions(
  sess: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isBrowserPermissionAllowed(permission))
  })
  // A request grant can be cached by Chromium even when later checks return
  // false. Keep page capabilities denied and expose copy/capture through
  // Copse-owned controls instead of trying to emulate a one-shot grant.
  sess.setPermissionCheckHandler(() => false)
}
