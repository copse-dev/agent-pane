import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToMarkdown } from './web-search/markdown.ts'
import {
  decodeDdgRedirectUrl,
  parseDdgHtmlResults,
  DDG_BLOCKED_HELP,
} from './web-search/duckduck.ts'

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

  it('parses result titles, urls, and snippets from HTML lite markup', () => {
    const hits = parseDdgHtmlResults(
      `
      <div class="result results_links results_links_deep web-result ">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=abc">The starting point for learning TypeScript</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=abc">Learn <b>TypeScript</b> from the official site.</a>
        </div>
      </div>
    `,
      5,
    )

    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.title, 'The starting point for learning TypeScript')
    assert.equal(hits[0]?.url, 'https://www.typescriptlang.org/docs/')
    assert.equal(hits[0]?.snippet, 'Learn TypeScript from the official site.')
  })

  it('documents actionable guidance when DDG blocks scraping', () => {
    assert.match(DDG_BLOCKED_HELP, /Wait a minute/)
    assert.match(DDG_BLOCKED_HELP, /fetch_url/)
    assert.doesNotMatch(DDG_BLOCKED_HELP, /BRAVE/)
  })
})
