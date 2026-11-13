import type { Session } from 'electron'

export type BrowserPermissionProfile = 'interactive' | 'restricted'

// The visible browser retains two gesture-gated browser affordances. Agent
// automation and hidden previews remain deny-all. Keep this list explicit: a
// new Chromium permission must never inherit access by omission.
const INTERACTIVE_BROWSER_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
])

export function isBrowserPermissionAllowed(
  permission: string,
  profile: BrowserPermissionProfile,
): boolean {
  return profile === 'interactive' && INTERACTIVE_BROWSER_PERMISSIONS.has(permission)
}

/** Install before creating guests; checks and requests must use the same policy. */
export function configureBrowserPermissions(
  sess: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  profile: BrowserPermissionProfile = 'restricted',
): void {
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isBrowserPermissionAllowed(permission, profile))
  })
  sess.setPermissionCheckHandler((_wc, permission) =>
    isBrowserPermissionAllowed(permission, profile),
  )
}
