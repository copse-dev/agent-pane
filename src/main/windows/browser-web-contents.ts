import { session } from 'electron'
import type { WebContents } from 'electron'
import { BROWSER_SESSION_PARTITION } from '@shared/browser-session.ts'

let browserSession: Electron.Session | undefined

// The in-app browser loads arbitrary, agent-chosen external pages, so it is
// untrusted. Default-deny the powerful web-platform permissions a hostile page
// could abuse (camera/mic, geolocation, device access, clipboard reads, …).
// Anything not listed here (e.g. fullscreen) keeps Chromium's default handling.
const DENIED_BROWSER_PERMISSIONS = new Set<string>([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'openExternal',
  'hid',
  'serial',
  'usb',
  'clipboard-read',
])

function configureBrowserSession(sess: Electron.Session): void {
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_BROWSER_PERMISSIONS.has(permission))
  })
  sess.setPermissionCheckHandler((_wc, permission) => !DENIED_BROWSER_PERMISSIONS.has(permission))
}

/** The isolated, persistent session shared by the in-app browser pane and tools. */
export function getInAppBrowserSession(): Electron.Session {
  if (!browserSession) {
    browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
    configureBrowserSession(browserSession)
  }
  return browserSession
}

/** True for in-sidebar browser guest pages that must load external https URLs. */
export function isBrowserWebContents(contents: WebContents): boolean {
  return contents.session === getInAppBrowserSession()
}
