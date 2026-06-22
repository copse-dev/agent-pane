import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  isWebOriginAllowed,
  normalizeWebAllowedOrigins,
  parseFetchUrl,
  validateWebOriginPattern,
  webAllowedOriginsWithDefaults,
  webOriginKey,
} from './web-origin-policy.ts'

describe('web-origin-policy', () => {
  it('allows default low-risk origins only', () => {
    assert.equal(
      isWebOriginAllowed(
        new URL('https://duckduckgo.com/html?q=test'),
        DEFAULT_WEB_ALLOWED_ORIGINS,
      ),
      true,
    )
    assert.equal(
      isWebOriginAllowed(new URL('http://localhost:5173'), DEFAULT_WEB_ALLOWED_ORIGINS),
      true,
    )
    assert.equal(
      isWebOriginAllowed(new URL('https://example.com'), DEFAULT_WEB_ALLOWED_ORIGINS),
      false,
    )
  })

  it('matches wildcard subdomains without matching the parent domain', () => {
    const allowed = normalizeWebAllowedOrigins(['https://*.example.com'])
    assert.equal(isWebOriginAllowed(new URL('https://docs.example.com'), allowed), true)
    assert.equal(isWebOriginAllowed(new URL('https://example.com'), allowed), false)
  })

  it('normalizes explicit origin keys with default ports', () => {
    assert.equal(webOriginKey(new URL('https://example.com/docs')), 'https://example.com:443')
    assert.equal(webOriginKey(new URL('http://[::1]:3000')), 'http://[::1]:3000')
  })

  it('blocks private and local network fetch targets except loopback', () => {
    assert.doesNotThrow(() => parseFetchUrl('http://localhost:3000'))
    assert.throws(() => parseFetchUrl('http://169.254.169.254/latest'), /private|link-local/)
    assert.throws(() => parseFetchUrl('http://printer.local'), /local network/)
    assert.throws(() => parseFetchUrl('ftp://example.com/file'), /HTTP\/HTTPS/)
  })

  it('validates origin allowlist entries', () => {
    assert.equal(validateWebOriginPattern(' HTTPS://DuckDuckGo.com '), 'https://duckduckgo.com')
    assert.throws(() => validateWebOriginPattern('https://example.com/path'), /must not include/)
  })

  it('uses defaults when no allowlist is saved', () => {
    assert.deepEqual(webAllowedOriginsWithDefaults(null), [...DEFAULT_WEB_ALLOWED_ORIGINS])
  })
})
