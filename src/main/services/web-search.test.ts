import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToMarkdown } from './web-search/markdown.ts'
import { decodeDdgRedirectUrl, DDG_BLOCKED_HELP } from './web-search/duckduck.ts'

describe('web search markdown', () => {
  it('strips scripts and converts headings', () => {
    const md = htmlToMarkdown(`
      <html><body>
        <script>alert(1)</script>
        <h1>Title</h1>
        <p>Hello <strong>world</strong>.</p>
      </body></html>
    `)
    assert.match(md, /# Title/)
    assert.match(md, /\*\*world\*\*/)
    assert.doesNotMatch(md, /alert/)
  })
})

describe('duckduck html search', () => {
  it('decodes DuckDuckGo redirect URLs', () => {
    const href =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=abc'
    assert.equal(decodeDdgRedirectUrl(href), 'https://www.typescriptlang.org/docs/')
  })

  it('documents actionable guidance when DDG blocks scraping', () => {
    assert.match(DDG_BLOCKED_HELP, /Wait a minute/)
    assert.match(DDG_BLOCKED_HELP, /fetch_url/)
    assert.doesNotMatch(DDG_BLOCKED_HELP, /BRAVE/)
  })
})
