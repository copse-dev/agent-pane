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

/** The `copse.me` shell: the one page that may frame this Mac's trusted names. */
export const COPSE_SHELL_ORIGIN = 'https://copse.me'

/**
 * The same headers for a response served under this Mac's trusted name
 * (`lan.` or `web.<label>.u.copse.me`) while the `copse.me` shell may frame it
 * (copse-web-access plan, decision 9; only while the relay is chosen). A page
 * framable by nothing becomes framable by the shell and nothing wider; a
 * same-origin-only frame (the Mermaid diagram frame) also admits the shell,
 * because `frame-ancestors` checks every ancestor and the shell is the top one.
 * `X-Frame-Options` goes either way: it cannot name another origin and would
 * override the policy in older browsers. The bare-IP origin keeps both.
 */
export function shellFramableHeaders(headers: Record<string, string>): Record<string, string> {
  const policy = headers['Content-Security-Policy']
  if (policy === undefined) return headers
  let framablePolicy: string
  if (policy.includes("frame-ancestors 'none'"))
    framablePolicy = policy.replace(
      "frame-ancestors 'none'",
      `frame-ancestors ${COPSE_SHELL_ORIGIN}`,
    )
  else if (/frame-ancestors 'self'(?:;|$)/.test(policy))
    framablePolicy = policy.replace(
      "frame-ancestors 'self'",
      `frame-ancestors 'self' ${COPSE_SHELL_ORIGIN}`,
    )
  else return headers
  const framable: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers))
    if (name !== 'X-Frame-Options') framable[name] = value
  framable['Content-Security-Policy'] = framablePolicy
  return framable
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
