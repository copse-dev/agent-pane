import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatMarkdownQuote } from './markdown-quote.ts'

describe('formatMarkdownQuote', () => {
  it('prefixes a single line', () => {
    assert.equal(formatMarkdownQuote('hello world'), '> hello world')
  })

  it('prefixes every line of a multi-line selection', () => {
    assert.equal(formatMarkdownQuote('first\nsecond\nthird'), '> first\n> second\n> third')
  })

  it('uses a bare > for blank lines so the blockquote stays one block', () => {
    assert.equal(formatMarkdownQuote('first\n\nsecond'), '> first\n>\n> second')
  })

  it('normalizes CRLF line endings', () => {
    assert.equal(formatMarkdownQuote('a\r\nb'), '> a\n> b')
  })
})
