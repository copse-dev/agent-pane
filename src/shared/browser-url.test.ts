import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { browserTabLabel, normalizeBrowserUrl } from './browser-url.ts'

describe('normalizeBrowserUrl', () => {
  it('returns about:blank for empty input', () => {
    assert.equal(normalizeBrowserUrl(''), 'about:blank')
    assert.equal(normalizeBrowserUrl('   '), 'about:blank')
  })

  it('preserves explicit http(s) URLs', () => {
    assert.equal(normalizeBrowserUrl('https://example.com/path'), 'https://example.com/path')
    assert.equal(normalizeBrowserUrl('http://localhost:3000'), 'http://localhost:3000')
  })

  it('adds https to bare hostnames', () => {
    assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com')
    assert.equal(normalizeBrowserUrl('docs.example.com/guide'), 'https://docs.example.com/guide')
    assert.equal(normalizeBrowserUrl('localhost:8080'), 'https://localhost:8080')
  })

  it('treats non-URL text as a search query', () => {
    assert.equal(
      normalizeBrowserUrl('electron webview'),
      'https://www.google.com/search?q=electron%20webview',
    )
  })
})

describe('browserTabLabel', () => {
  it('prefers page title when present', () => {
    assert.equal(browserTabLabel('https://example.com', 'Example Domain'), 'Example Domain')
  })

  it('falls back to hostname or New tab', () => {
    assert.equal(browserTabLabel('about:blank'), 'New tab')
    assert.equal(browserTabLabel('https://github.com/foo'), 'github.com')
  })
})
