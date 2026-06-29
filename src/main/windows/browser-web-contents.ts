import { session } from 'electron'
import type { WebContents } from 'electron'
import {
  BROWSER_AGENT_SESSION_PARTITION,
  BROWSER_SESSION_PARTITION,
} from '@shared/browser-session.ts'
import { getMainWindow } from './create-main-window.ts'
import { browserGuestWindowOpen } from './web-contents-lockdown.ts'
import { isAllowedBrowserNavigationUrl } from '../services/browser/browser-origin-policy.ts'

let browserSession: Electron.Session | undefined
let agentBrowserSession: Electron.Session | undefined

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

/** The isolated, persistent session for the visible in-app browser pane. */
export function getInAppBrowserSession(): Electron.Session {
  if (!browserSession) {
    browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
    configureBrowserSession(browserSession)
  }
  return browserSession
}

/**
 * Separate persistent session for agent-driven browser automation (#467). Same
 * lockdown/permission posture as the pane session (configureBrowserSession), but
 * its own cookie jar/storage so the agent never inherits the user's interactive
 * logins — and the user is never silently browsing under the agent's profile.
 */
export function getAgentBrowserSession(): Electron.Session {
  if (!agentBrowserSession) {
    agentBrowserSession = session.fromPartition(BROWSER_AGENT_SESSION_PARTITION)
    configureBrowserSession(agentBrowserSession)
  }
  return agentBrowserSession
}

/** True for in-sidebar browser guest pages and agent automation tabs. */
export function isBrowserWebContents(contents: WebContents): boolean {
  return (
    contents.session === getInAppBrowserSession() || contents.session === getAgentBrowserSession()
  )
}

/** Block popups from browser guests, reopening webview links as renderer tabs. */
export function attachBrowserGuestWindowOpen(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const { openTabUrl } = browserGuestWindowOpen(contents.getType(), url)
    if (openTabUrl) getMainWindow()?.webContents.send('browser:open-tab', openTabUrl)
    return { action: 'deny' }
  })

  // The guest browses the public web freely, but a hostile page or redirect must
  // not be able to drive it to file:/chrome:/data: and render local or privileged
  // content inside the guest. Restrict its own navigations to web schemes.
  const blockNonWebScheme = (event: Electron.Event, url: string): void => {
    if (!isAllowedBrowserNavigationUrl(url)) event.preventDefault()
  }
  contents.on('will-navigate', blockNonWebScheme)
  contents.on('will-redirect', blockNonWebScheme)
}
