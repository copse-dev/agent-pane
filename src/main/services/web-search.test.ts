import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToMarkdown } from './web-search/markdown.ts'

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
