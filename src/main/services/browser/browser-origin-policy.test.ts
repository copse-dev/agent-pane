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
