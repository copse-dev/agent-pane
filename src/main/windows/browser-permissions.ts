import type { Session } from 'electron'

// Neither interactive browsing nor agent automation needs a guest-page grant.
// Host-owned copy/paste, exports and capturePage do not use these permissions.
// Keep exceptions explicit: a new Chromium permission must never inherit access.
const ALLOWED_BROWSER_PERMISSIONS: ReadonlySet<string> = new Set<string>()

export function isBrowserPermissionAllowed(permission: string): boolean {
  return ALLOWED_BROWSER_PERMISSIONS.has(permission)
}

/** Install before creating guests; checks and requests must use the same policy. */
export function configureBrowserPermissions(
  sess: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isBrowserPermissionAllowed(permission))
  })
  sess.setPermissionCheckHandler((_wc, permission) => isBrowserPermissionAllowed(permission))
}
