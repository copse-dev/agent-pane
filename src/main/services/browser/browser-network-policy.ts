import { isAllowedBrowserNavigationUrl } from './browser-origin-policy.ts'
import { isStaticPreviewUrl } from './static-preview-server.ts'
import { matchesWebOriginAllowlist, parseFetchUrl } from '../security/web-origin-policy.ts'

function isRestrictedPreview(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return ['data:', 'file:', 'about:'].includes(parsed.protocol) || isStaticPreviewUrl(url)
}

export type BrowserOriginAccess = 'allowlisted' | 'public-web'

/** Applied to every request, including redirects, nested frames and WebSockets. */
export function isBrowserRequestAllowed(input: {
  url: string
  documentUrl: string
  resourceType: string
  allowedOrigins: readonly string[]
  originAccess: BrowserOriginAccess
}): boolean {
  const { url, documentUrl, resourceType, allowedOrigins, originAccess } = input
  if (!URL.canParse(url)) return false
  const target = new URL(url)
  // DevTools documents are app-internal UI Chromium loads for the guest's own
  // inspector (openDevTools/inspectElement); the session request hook sees them
  // too and must not cancel them, or the inspector window stays blank with
  // ERR_BLOCKED_BY_CLIENT. Guest pages still cannot reach devtools: themselves —
  // will-frame-navigate/isAllowedBrowserNavigationUrl restrict page-driven
  // navigation to http/https.
  if (target.protocol === 'devtools:') return true
  if (target.protocol === 'data:' || url === 'about:blank') return true
  // file navigation is not supported by the browser tools; don't introduce local file access.
  if (target.protocol === 'blob:') return resourceType !== 'mainFrame'
  if (target.protocol === 'ws:') target.protocol = 'http:'
  if (target.protocol === 'wss:') target.protocol = 'https:'
  try {
    parseFetchUrl(target.href)
    if (originAccess === 'allowlisted' && !matchesWebOriginAllowlist(target, allowedOrigins)) {
      return false
    }
  } catch {
    return false
  }
  if (resourceType === 'mainFrame') return true
  return isDocumentNetworkAllowed(documentUrl, target)
}

function isDocumentNetworkAllowed(documentUrl: string, target: URL): boolean {
  // Requests without an owning document (e.g. a service worker) fail closed.
  if (!URL.canParse(documentUrl)) return false
  const document = new URL(documentUrl)
  if (isRestrictedPreview(documentUrl)) {
    return document.origin !== 'null' && target.origin === document.origin
  }
  return document.protocol === 'http:' || document.protocol === 'https:'
}

/** Page-controlled navigation must obey the originating document's network limits.
 * Host-requested loadURL navigation is separately checked by the request allowlist.
 */
export function isBrowserPageNavigationAllowed(documentUrl: string, url: string): boolean {
  if (!isAllowedBrowserNavigationUrl(url)) return false
  if (url === 'about:blank') return true
  return isDocumentNetworkAllowed(documentUrl, new URL(url))
}
