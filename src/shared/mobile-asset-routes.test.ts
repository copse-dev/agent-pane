import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mobileAssetRoutes,
  mobileResponseHeaders,
  shellFramableHeaders,
} from './mobile-asset-routes.ts'
import { MOBILE_CONTENT_SECURITY_POLICY } from './mobile-content-security-policy.ts'

describe('mobile asset routes', () => {
  it('serves the app under the page policy, which frames only same-origin documents', () => {
    const routes = mobileAssetRoutes()
    assert.deepEqual([...routes.keys()].sort(), ['/', '/app.css', '/app.js', '/mermaid-frame.html'])
    for (const route of ['/', '/app.css', '/app.js']) {
      const headers = routes.get(route)?.headers
      assert.equal(headers?.['Content-Security-Policy'], MOBILE_CONTENT_SECURITY_POLICY)
      assert.equal(headers['X-Frame-Options'], 'DENY')
      assert.equal(headers['Cache-Control'], 'no-store')
    }
    assert.match(MOBILE_CONTENT_SECURITY_POLICY, /frame-src 'self';/)
    assert.match(MOBILE_CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/)
  })
  it('lets only this origin embed the Mermaid frame, which carries its own CSP', () => {
    const headers = mobileAssetRoutes().get('/mermaid-frame.html')?.headers
    // The page policy would block the frame's hash-pinned inline script; the
    // document's meta CSP (no network, no fonts, no images) governs it instead.
    assert.equal(headers?.['Content-Security-Policy'], "frame-ancestors 'self'")
    assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN')
    assert.equal(headers['X-Content-Type-Options'], 'nosniff')
    // Large and loaded once per diagram: revalidated rather than re-downloaded.
    assert.equal(headers['Cache-Control'], 'no-cache')
  })
  it('lets only the copse.me shell frame a trusted-name response', () => {
    const base = mobileResponseHeaders('text/html; charset=utf-8')
    const framed = shellFramableHeaders(base)
    assert.equal(framed['X-Frame-Options'], undefined)
    assert.match(framed['Content-Security-Policy'] ?? '', /frame-ancestors https:\/\/copse\.me$/)
    assert.doesNotMatch(framed['Content-Security-Policy'] ?? '', /'none'$/)
    // Everything else is unchanged, and the bare-IP headers are untouched.
    assert.equal(framed['Content-Type'], base['Content-Type'])
    assert.equal(framed['Cache-Control'], 'no-store')
    assert.equal(base['X-Frame-Options'], 'DENY')
  })
  it('lets the diagram frame be nested inside the shell too', () => {
    // frame-ancestors checks every ancestor: a diagram frame inside the page inside
    // copse.me must admit the shell as well as its own origin, or it is refused.
    const mermaid = mobileAssetRoutes().get('/mermaid-frame.html')?.headers ?? {}
    const framed = shellFramableHeaders(mermaid)
    assert.equal(framed['Content-Security-Policy'], "frame-ancestors 'self' https://copse.me")
    assert.equal(framed['X-Frame-Options'], undefined)
    assert.equal(framed['Cache-Control'], 'no-cache')
    assert.equal(mermaid['X-Frame-Options'], 'SAMEORIGIN')
  })
  it('leaves a policy with other ancestors alone', () => {
    const headers = { 'Content-Security-Policy': "frame-ancestors 'self' https://a.test" }
    assert.deepEqual(shellFramableHeaders(headers), headers)
    assert.deepEqual(shellFramableHeaders({ 'Content-Type': 'text/plain' }), {
      'Content-Type': 'text/plain',
    })
  })
})
