import { PREVIEW_CSP } from '@shared/preview-csp.ts'
import { isLoopbackHost } from './browser-origin-policy.ts'
import { matchesWebOriginAllowlist, parseFetchUrl } from '../security/web-origin-policy.ts'

export function isLocalPreview(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return ['data:', 'file:', 'about:'].includes(parsed.protocol) || isLoopbackHost(parsed.hostname)
}

/** Applied to every request, including redirects, nested frames and WebSockets. */
export function isBrowserRequestAllowed(input: {
  url: string
  documentUrl: string
  resourceType: string
  allowedOrigins: readonly string[]
}): boolean {
  const { url, documentUrl, resourceType, allowedOrigins } = input
  if (!URL.canParse(url)) return false
  const target = new URL(url)
  if (target.protocol === 'data:' || url === 'about:blank') return true
  // file navigation is not supported by the browser tools; don't introduce local file access.
  if (target.protocol === 'blob:') return resourceType !== 'mainFrame'
  if (target.protocol === 'ws:') target.protocol = 'http:'
  if (target.protocol === 'wss:') target.protocol = 'https:'
  try {
    parseFetchUrl(target.href)
    if (!matchesWebOriginAllowlist(target, allowedOrigins)) return false
  } catch {
    return false
  }
  if (resourceType === 'mainFrame') return true
  // Requests without an owning document (e.g. a service worker) fail closed.
  if (!URL.canParse(documentUrl)) return false
  const document = new URL(documentUrl)
  if (isLocalPreview(documentUrl)) {
    return document.origin !== 'null' && target.origin === document.origin
  }
  return document.protocol === 'http:' || document.protocol === 'https:'
}

/** Preserve the server's CSP: multiple policies intersect, never replace it. */
export function previewResponseHeaders(
  url: string,
  headers: Record<string, string[]> = {},
): Record<string, string[]> {
  if (!isLocalPreview(url)) return headers
  const result = { ...headers }
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === 'content-security-policy') ??
    'Content-Security-Policy'
  result[key] = [...(result[key] ?? []), PREVIEW_CSP]
  return result
}
