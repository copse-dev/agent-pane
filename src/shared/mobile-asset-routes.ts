import { MOBILE_CONTENT_SECURITY_POLICY } from './mobile-content-security-policy.ts'

/**
 * Headers for every Copse LAN response: no caching, no framing, no sniffing.
 *
 * `no-store` is the default for every route. The server lifts it for exactly one
 * case: a script or stylesheet requested under the content hash the page pinned
 * it to with Subresource Integrity (`pinPageAssets`). Every API response, and the
 * page itself, is never stored.
 */
export function mobileResponseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': MOBILE_CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

/**
 * The fixed asset routes, by URL path. Nothing here is derived from a request.
 *
 * `mermaid-frame.html` is the desktop's isolated diagram document. It is loaded
 * in a `sandbox="allow-scripts"` iframe and carries its own hash-pinned meta CSP
 * (no network, no same-origin access). Its header therefore only permits this
 * origin to embed it; the page policy would block its inline script.
 */
export function mobileAssetRoutes(): Map<
  string,
  { path: string; headers: Record<string, string> }
> {
  const html = 'text/html; charset=utf-8'
  return new Map([
    ['/', { path: 'index.html', headers: mobileResponseHeaders(html) }],
    ['/app.css', { path: 'app.css', headers: mobileResponseHeaders('text/css; charset=utf-8') }],
    [
      '/app.js',
      { path: 'app.js', headers: mobileResponseHeaders('text/javascript; charset=utf-8') },
    ],
    [
      '/mermaid-frame.html',
      {
        path: 'mermaid-frame.html',
        headers: {
          ...mobileResponseHeaders(html),
          // Large and loaded once per diagram: revalidate (ETag) instead of
          // re-downloading. A frame cannot carry Subresource Integrity, so it
          // is revalidated rather than pinned like the page's own bundles.
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "frame-ancestors 'self'",
          'X-Frame-Options': 'SAMEORIGIN',
        },
      },
    ],
  ])
}
