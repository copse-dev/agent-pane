import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mobileAssetRoutes } from './mobile-asset-routes.ts'
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
})
