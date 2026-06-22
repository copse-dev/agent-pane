import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { browserTabLabel, normalizeBrowserUrl } from './browser-url.ts'

function duckDuckGoSearch(query: string): string {
  const url = new URL('https://duckduckgo.com/')
  url.searchParams.set('q', query)
  return url.href
}

describe('normalizeBrowserUrl', () => {
  it('returns about:blank for empty input', () => {
    assert.equal(normalizeBrowserUrl(''), 'about:blank')
    assert.equal(normalizeBrowserUrl('   '), 'about:blank')
  })

  it('preserves explicit http(s) URLs', () => {
    assert.equal(normalizeBrowserUrl('https://example.com/path'), 'https://example.com/path')
    assert.equal(normalizeBrowserUrl('http://localhost:3000'), 'http://localhost:3000/')
  })

  it('adds https to bare hostnames using URL + PSL checks', () => {
    assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/')
    assert.equal(normalizeBrowserUrl('docs.example.com/guide'), 'https://docs.example.com/guide')
    assert.equal(normalizeBrowserUrl('example.co.uk'), 'https://example.co.uk/')
    assert.equal(normalizeBrowserUrl('localhost:8080'), 'https://localhost:8080/')
    assert.equal(normalizeBrowserUrl('127.0.0.1:8080'), 'https://127.0.0.1:8080/')
  })

  it('treats bare public suffixes and plain text as DuckDuckGo searches', () => {
    assert.equal(normalizeBrowserUrl('electron webview'), duckDuckGoSearch('electron webview'))
    assert.equal(normalizeBrowserUrl('co.uk'), duckDuckGoSearch('co.uk'))
    assert.equal(normalizeBrowserUrl('notepad'), duckDuckGoSearch('notepad'))
  })

  it('does not treat non-http schemes as navigable URLs', () => {
    assert.equal(
      normalizeBrowserUrl('javascript:alert(1)'),
      duckDuckGoSearch('javascript:alert(1)'),
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
