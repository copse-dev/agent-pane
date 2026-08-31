import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideBrowserNavigation,
  isAllowedBrowserNavigationUrl,
  isBlockedHost,
  isLoopbackHost,
  parseBrowserUrl,
} from './browser-origin-policy.ts'

describe('parseBrowserUrl', () => {
  it('normalizes default ports into the origin key', () => {
    assert.equal(parseBrowserUrl('https://example.com/docs')?.origin, 'https://example.com:443')
    assert.equal(parseBrowserUrl('http://example.com')?.origin, 'http://example.com:80')
  })

  it('keeps explicit ports', () => {
    assert.equal(parseBrowserUrl('http://localhost:5173/app')?.origin, 'http://localhost:5173')
  })

  it('rejects non-http(s) schemes', () => {
    assert.equal(parseBrowserUrl('file:///etc/passwd'), null)
    assert.equal(parseBrowserUrl('javascript:alert(1)'), null)
    assert.equal(parseBrowserUrl('not a url'), null)
  })
})

describe('isAllowedBrowserNavigationUrl', () => {
  it('allows http, https, and about:blank', () => {
    assert.equal(isAllowedBrowserNavigationUrl('http://example.com/x'), true)
    assert.equal(isAllowedBrowserNavigationUrl('https://example.com/x'), true)
    assert.equal(isAllowedBrowserNavigationUrl('about:blank'), true)
  })

  it('blocks file, chrome, data, and other privileged schemes', () => {
    assert.equal(isAllowedBrowserNavigationUrl('file:///etc/passwd'), false)
    assert.equal(isAllowedBrowserNavigationUrl('chrome://settings'), false)
    assert.equal(isAllowedBrowserNavigationUrl('data:text/html,<h1>hi</h1>'), false)
    assert.equal(isAllowedBrowserNavigationUrl('javascript:alert(1)'), false)
    assert.equal(isAllowedBrowserNavigationUrl('not a url'), false)
  })
})

describe('isLoopbackHost', () => {
  it('matches localhost variants and 127.0.0.0/8', () => {
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('app.localhost'), true)
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('127.5.5.5'), true)
    assert.equal(isLoopbackHost('::1'), true)
    assert.equal(isLoopbackHost('example.com'), false)
  })

  it('matches ::1 and loopback written in every spelling', () => {
    assert.equal(isLoopbackHost('[::1]'), true)
    assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true)
    // A loopback dev server addressed through an IPv4-mapped literal reaches
    // the same socket, so it must not be treated as a public origin.
    assert.equal(isLoopbackHost('[::ffff:127.0.0.1]'), true)
    // The hex spelling of the same mapped address.
    assert.equal(isLoopbackHost('::ffff:7f00:1'), true)
    assert.equal(isLoopbackHost('[::ffff:8.8.8.8]'), false)
  })
})

describe('isBlockedHost', () => {
  it('flags private ranges, link-local, and metadata', () => {
    assert.equal(isBlockedHost('10.0.0.5'), true)
    assert.equal(isBlockedHost('192.168.1.10'), true)
    assert.equal(isBlockedHost('172.16.0.1'), true)
    assert.equal(isBlockedHost('169.254.169.254'), true)
    assert.equal(isBlockedHost('0.0.0.0'), true)
    assert.equal(isBlockedHost('fd00::1'), true)
  })

  it('does not flag public hosts or loopback', () => {
    assert.equal(isBlockedHost('example.com'), false)
    assert.equal(isBlockedHost('127.0.0.1'), false)
    assert.equal(isBlockedHost('8.8.8.8'), false)
  })

  it('does not mistake a hostname for an IPv6 range', () => {
    // `startsWith('fc')` / `'fd'` / `'fe8'` matched names as well as literals,
    // so every one of these public sites was denied as "private/link-local".
    for (const host of [
      'fda.gov',
      'fcc.gov',
      'fdic.gov',
      'fdroid.org',
      'fc-barcelona.com',
      'fe8.dev',
      'fe80.example.com',
    ]) {
      assert.equal(isBlockedHost(host), false, `${host} is a public hostname, not an address`)
    }
  })

  it('covers the whole of fc00::/7 and fe80::/10, and nothing either side', () => {
    // fe80::/10 runs to febf, so a `fe8` prefix test missed three quarters of it.
    assert.equal(isBlockedHost('fc00::'), true)
    assert.equal(isBlockedHost('fdff:ffff::1'), true)
    assert.equal(isBlockedHost('fbff::1'), false)
    assert.equal(isBlockedHost('fe80::1'), true)
    assert.equal(isBlockedHost('fe90::1'), true)
    assert.equal(isBlockedHost('febf::1'), true)
    assert.equal(isBlockedHost('fe7f::1'), false)
    assert.equal(isBlockedHost('fec0::1'), false) // deprecated site-local, outside the /10
    assert.equal(isBlockedHost('2001:4860:4860::8888'), false)
  })

  it('blocks a private address embedded in an IPv6 literal', () => {
    // These reach exactly the hosts the plain-IPv4 forms above reach.
    assert.equal(isBlockedHost('[::ffff:169.254.169.254]'), true)
    // What `new URL()` normalises the line above to.
    assert.equal(isBlockedHost('[::ffff:a9fe:a9fe]'), true)
    assert.equal(isBlockedHost('[::ffff:192.168.1.1]'), true)
    assert.equal(isBlockedHost('[::ffff:10.0.0.5]'), true)
    assert.equal(isBlockedHost('[64:ff9b::169.254.169.254]'), true)
    assert.equal(isBlockedHost('[::ffff:8.8.8.8]'), false)
  })

  it('treats malformed input as a hostname rather than throwing', () => {
    for (const host of ['', 'not:an:address', '::ffff:999.1.1.1', 'fc00:::1', '1.2.3']) {
      assert.equal(isBlockedHost(host), false, host)
    }
  })
})

describe('decideBrowserNavigation', () => {
  const base = { allowedOrigins: [] as string[], allowUserApproval: true }

  it('allows loopback dev servers without prompting', () => {
    const d = decideBrowserNavigation({ url: 'http://localhost:3000', ...base })
    assert.equal(d.action, 'allow')
  })

  it('prompts for a new public origin', () => {
    const d = decideBrowserNavigation({ url: 'https://example.com/x', ...base })
    assert.equal(d.action, 'prompt')
    assert.equal(d.origin, 'https://example.com:443')
  })

  it('allows a remembered public origin', () => {
    const d = decideBrowserNavigation({
      url: 'https://example.com/x',
      allowedOrigins: ['https://example.com:443'],
      allowUserApproval: true,
    })
    assert.equal(d.action, 'allow')
  })

  it('denies private targets without prompting', () => {
    const d = decideBrowserNavigation({ url: 'http://169.254.169.254/latest', ...base })
    assert.equal(d.action, 'deny')
  })

  it('denies the same target written as an IPv4-mapped IPv6 literal', () => {
    // Reaches the same host; previously this returned `prompt`, describing a
    // link-local address to the user as a new public web origin — and an
    // approval taken with "remember" would have persisted it as an allowed
    // origin, so it would never prompt again.
    const d = decideBrowserNavigation({
      url: 'http://[::ffff:169.254.169.254]/latest',
      ...base,
    })
    assert.equal(d.action, 'deny')
  })

  it('prompts for a public site whose name begins fc, fd or fe8', () => {
    // These were denied outright with "is a private/link-local address".
    for (const url of ['https://fda.gov/x', 'https://fcc.gov/x', 'https://fdroid.org/x']) {
      assert.equal(decideBrowserNavigation({ url, ...base }).action, 'prompt', url)
    }
  })

  it('denies new origins when approval is disabled', () => {
    const d = decideBrowserNavigation({
      url: 'https://example.com',
      allowedOrigins: [],
      allowUserApproval: false,
    })
    assert.equal(d.action, 'deny')
  })

  it('denies unsupported schemes', () => {
    const d = decideBrowserNavigation({ url: 'file:///etc/passwd', ...base })
    assert.equal(d.action, 'deny')
    assert.equal(d.origin, null)
  })
})
