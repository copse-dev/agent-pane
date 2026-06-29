import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  fetchWithWebOriginPolicy,
  isWebOriginAllowed,
  normalizeWebAllowedOrigins,
  parseFetchUrl,
  sandboxAllowedDomainsFromOrigins,
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

  it('converts origins to sandbox proxy domain rules', () => {
    assert.deepEqual(
      sandboxAllowedDomainsFromOrigins([
        'https://example.com:8443',
        'https://*.example.com',
        'http://localhost:*',
        'https://example.com',
      ]),
      ['example.com', '*.example.com', 'localhost'],
    )
  })
})

describe('fetchWithWebOriginPolicy abort composition', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // Capture the signal the policy hands to fetch so we can assert how it is
  // composed, and return a terminal 200 so there's no redirect follow-up.
  function stubFetch(): () => AbortSignal | null | undefined {
    let captured: AbortSignal | null | undefined
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      captured = init?.signal
      return Promise.resolve(new Response('ok', { status: 200 }))
    })
    return () => captured
  }

  it('forwards a live (non-aborted) timeout signal when the caller passes none', async () => {
    const getSignal = stubFetch()
    await fetchWithWebOriginPolicy(
      new URL('https://duckduckgo.com/'),
      {},
      DEFAULT_WEB_ALLOWED_ORIGINS,
    )
    const signal = getSignal()
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
  })

  it("aborts the fetch when the caller's signal aborts (AbortSignal.any)", async () => {
    const getSignal = stubFetch()
    const caller = new AbortController()
    await fetchWithWebOriginPolicy(
      new URL('https://duckduckgo.com/'),
      { signal: caller.signal },
      DEFAULT_WEB_ALLOWED_ORIGINS,
    )
    const signal = getSignal()
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)

    // The signal handed to fetch is AbortSignal.any([caller, timeout]); aborting
    // the caller must propagate to it.
    caller.abort()
    assert.equal(signal.aborted, true)
  })
})
