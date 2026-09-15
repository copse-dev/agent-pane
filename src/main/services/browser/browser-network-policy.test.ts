import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBrowserPageNavigationAllowed,
  isBrowserRequestAllowed,
} from './browser-network-policy.ts'
import { PREVIEW_CSP, securePreviewHtml } from '@shared/preview-csp.ts'
import { grantWebOriginForNextFetch, clearWebOriginGrant } from '../security/web-origin-policy.ts'

const allowedOrigins = ['http://localhost:*', 'https://example.com', 'https://*.assets.example.com']
const base = { allowedOrigins, documentUrl: 'http://localhost:3000', resourceType: 'image' }

describe('browser request network boundary', () => {
  it('allows allowlisted resources for regular local web traffic', () => {
    assert.equal(isBrowserRequestAllowed({ ...base, url: 'http://localhost:3000/image.png' }), true)
    assert.equal(isBrowserRequestAllowed({ ...base, url: 'http://localhost:4000/image.png' }), true)
    assert.equal(isBrowserRequestAllowed({ ...base, url: 'https://example.com/image.png' }), true)
    assert.equal(isBrowserRequestAllowed({ ...base, url: 'https://evil.example/image.png' }), false)
  })

  it('blocks network requests from data, blob, file, blank and ownerless documents', () => {
    for (const documentUrl of [
      'data:text/html,<img>',
      'blob:https://example.com/id',
      'file:///tmp/preview.html',
      'about:blank',
      '',
    ]) {
      for (const resourceType of [
        'image',
        'script',
        'stylesheet',
        'font',
        'subFrame',
        'xhr',
        'ping',
        'webSocket',
        'other',
      ]) {
        assert.equal(
          isBrowserRequestAllowed({
            ...base,
            documentUrl,
            resourceType,
            url: 'https://example.com/asset',
          }),
          false,
        )
      }
    }
  })

  it('enforces the allowlist on every navigation and redirect target', () => {
    assert.equal(
      isBrowserRequestAllowed({ ...base, resourceType: 'mainFrame', url: 'https://example.com' }),
      true,
    )
    for (const url of [
      'https://evil.example',
      'http://169.254.169.254',
      'file:///etc/passwd',
      'ftp://example.com',
      'javascript:alert(1)',
    ]) {
      assert.equal(isBrowserRequestAllowed({ ...base, resourceType: 'mainFrame', url }), false)
    }
    assert.equal(
      isBrowserRequestAllowed({
        ...base,
        allowedOrigins: [],
        resourceType: 'mainFrame',
        url: 'http://localhost:3000',
      }),
      false,
    )
  })

  it('blocks page-controlled network navigation from opaque previews', () => {
    for (const source of [
      'data:text/html,preview',
      'file:///tmp/preview.html',
      'about:blank',
      '',
      'blob:https://example.com/id',
    ]) {
      assert.equal(isBrowserPageNavigationAllowed(source, 'https://example.com'), false)
    }
    assert.equal(
      isBrowserPageNavigationAllowed('http://localhost:3000', 'http://localhost:3000/next'),
      true,
    )
    assert.equal(
      isBrowserPageNavigationAllowed('http://localhost:3000', 'http://localhost:4000/next'),
      true,
    )
    assert.equal(
      isBrowserPageNavigationAllowed('https://example.com', 'https://assets.example.com'),
      true,
    )
    assert.equal(isBrowserPageNavigationAllowed('https://example.com', 'file:///etc/passwd'), false)
    assert.equal(isBrowserPageNavigationAllowed('data:text/html,preview', 'about:blank'), true)
  })

  it('uses wildcard origins and checks WebSocket origins without opening all ports', () => {
    const input = { ...base, documentUrl: 'https://example.com' }
    assert.equal(
      isBrowserRequestAllowed({ ...input, url: 'https://cdn.assets.example.com/a.js' }),
      true,
    )
    assert.equal(
      isBrowserRequestAllowed({ ...input, url: 'https://assets.example.com.evil.com/a.js' }),
      false,
    )
    assert.equal(
      isBrowserRequestAllowed({ ...base, resourceType: 'webSocket', url: 'ws://localhost:3000' }),
      true,
    )
    assert.equal(
      isBrowserRequestAllowed({
        ...base,
        allowedOrigins: ['http://localhost:3000'],
        resourceType: 'webSocket',
        url: 'ws://localhost:4000',
      }),
      false,
    )
  })

  it('does not inherit a concurrent fetch tool grant', () => {
    grantWebOriginForNextFetch('https://evil.example:443')
    try {
      assert.equal(
        isBrowserRequestAllowed({
          ...base,
          resourceType: 'mainFrame',
          url: 'https://evil.example/',
        }),
        false,
      )
    } finally {
      clearWebOriginGrant('https://evil.example:443')
    }
  })

  it('prepends a restrictive policy to self-contained HTML prototypes', () => {
    assert.ok(
      securePreviewHtml('<script>run()</script>').startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
      ),
    )
  })
})
