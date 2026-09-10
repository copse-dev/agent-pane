import { session } from 'electron'
import type { WebContents } from 'electron'
import {
  BROWSER_AGENT_SESSION_PARTITION,
  BROWSER_SESSION_PARTITION,
  browserSessionPartition,
  isBrowserSessionPartition,
} from '@shared/browser-session.ts'
import { getMainWindow } from './create-main-window.ts'
import { browserGuestWindowOpen } from './web-contents-lockdown.ts'
import { isAllowedBrowserNavigationUrl } from '../services/browser/browser-origin-policy.ts'

import { browserAllowedOrigins } from '../services/browser/browser-network-grants.ts'
import {
  isBrowserRequestAllowed,
  isBrowserPageNavigationAllowed,
  previewResponseHeaders,
} from '../services/browser/browser-network-policy.ts'

const browserSessions = new Map<string, Electron.Session>()
const documents = new Map<number, string>()

// The in-app browser loads arbitrary, agent-chosen external pages, so it is
// untrusted. Default-deny the powerful web-platform permissions a hostile page
// could abuse (camera/mic, geolocation, device access, clipboard reads, …).
// Anything not listed here (e.g. fullscreen) keeps Chromium's default handling.
// Note: denying `clipboard-read` only blocks guest-page JS from reading the
// clipboard — main-process Copy Link / Copy Image (browser-context-menu) still
// writes via Electron's clipboard APIs.
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

function configureBrowserSession(sess: Electron.Session, scope: string): void {
  sess.webRequest.onBeforeRequest((details, callback) => {
    const documentUrl =
      details.webContentsId === undefined ? '' : (documents.get(details.webContentsId) ?? '')
    const frameUrl = details.frame?.url ?? ''
    const allowed = isBrowserRequestAllowed({
      url: details.url,
      documentUrl: frameUrl.startsWith('data:') ? frameUrl : documentUrl,
      resourceType: details.resourceType,
      allowedOrigins: browserAllowedOrigins(scope),
    })
    if (allowed && details.resourceType === 'mainFrame' && details.webContentsId !== undefined) {
      documents.set(details.webContentsId, details.url)
    }
    callback({ cancel: !allowed })
  })
  sess.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: previewResponseHeaders(details.url, details.responseHeaders) })
  })
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_BROWSER_PERMISSIONS.has(permission))
  })
  sess.setPermissionCheckHandler((_wc, permission) => !DENIED_BROWSER_PERMISSIONS.has(permission))
}

/** Configure before a guest is created, so its first request is already protected. */
export function getBrowserSessionForPartition(partition: string): Electron.Session | null {
  if (!isBrowserSessionPartition(partition)) return null
  let sess = browserSessions.get(partition)
  if (!sess) {
    sess = session.fromPartition(partition)
    const marker = partition.indexOf(':thread:')
    configureBrowserSession(sess, marker < 0 ? '' : partition.slice(marker + 1))
    browserSessions.set(partition, sess)
  }
  return sess
}

export function getInAppBrowserSession(): Electron.Session {
  const sess = getBrowserSessionForPartition(BROWSER_SESSION_PARTITION)
  if (!sess) throw new Error('Invalid browser partition')
  return sess
}

/** Task-specific automation profile, isolated from interactive logins and other tasks. */
export function getAgentBrowserSession(scope = ''): Electron.Session {
  const sess = getBrowserSessionForPartition(
    browserSessionPartition(BROWSER_AGENT_SESSION_PARTITION, scope),
  )
  if (!sess) throw new Error('Invalid agent browser partition')
  return sess
}

export function isBrowserWebContents(contents: WebContents): boolean {
  // Initialize legacy partitions too, used by existing callers and saved panes.
  getInAppBrowserSession()
  getAgentBrowserSession()
  return [...browserSessions.values()].includes(contents.session)
}

export function browserPartitionForContents(contents: WebContents): string | undefined {
  return [...browserSessions].find(([, sess]) => sess === contents.session)?.[0]
}

/** Block popups from browser guests, reopening webview links as renderer tabs. */
export function attachBrowserGuestWindowOpen(contents: WebContents): void {
  documents.set(contents.id, contents.getURL())
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) documents.set(contents.id, details.url)
  })
  contents.on('destroyed', () => documents.delete(contents.id))
  contents.setWindowOpenHandler(({ url }) => {
    const { openTabUrl } = browserGuestWindowOpen(contents.getType(), url)
    if (openTabUrl && isBrowserPageNavigationAllowed(contents.getURL(), openTabUrl)) {
      const partition = browserPartitionForContents(contents)
      getMainWindow()?.webContents.send('browser:open-tab', openTabUrl, partition)
    }
    return { action: 'deny' }
  })

  // Request interception enforces the allowlist. A hostile page or redirect must
  // not be able to drive it to file:/chrome:/data: and render local or privileged
  // content inside the guest. Restrict its own navigations to web schemes.
  // Cursor cloud-run pages (`cursor.com/agents/...`) load normally here — the
  // Copse thread handoff lives on the PR pane's "open agent thread" action, not
  // on browser navigation / chat links.
  const blockNonWebScheme = (event: Electron.Event, url: string): void => {
    if (!isAllowedBrowserNavigationUrl(url)) event.preventDefault()
  }
  // Unlike loadURL, this event is emitted for page-initiated navigation. Check
  // the initiating frame before Chromium replaces its URL with the destination.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) return
    const source = event.initiator?.url ?? event.frame?.url ?? contents.getURL()
    if (!isBrowserPageNavigationAllowed(source, event.url)) event.preventDefault()
  })
  contents.on('will-redirect', blockNonWebScheme)
}
