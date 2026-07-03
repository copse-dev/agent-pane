import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizeEscapedPunctuation,
  decodeEscapedPunctuation,
  decodeEscapedPunctuationRaw,
  encodeBackslashEscapes,
} from './backslash-escapes.ts'
import { renderMarkdown } from './renderer.ts'

describe('encodeBackslashEscapes', () => {
  it('round-trips escaped punctuation through the PUA encoding', () => {
    const encoded = encodeBackslashEscapes('\\*not emphasized\\*')
    assert.doesNotMatch(encoded, /\\/)
    assert.doesNotMatch(encoded, /\*/)
    assert.equal(decodeEscapedPunctuationRaw(encoded), '*not emphasized*')
  })

  it('is idempotent', () => {
    const once = encodeBackslashEscapes('\\[x\\]')
    assert.equal(encodeBackslashEscapes(once), once)
  })

  it('leaves backslashes before non-punctuation literal', () => {
    assert.equal(encodeBackslashEscapes('\\Alpha \\ beta'), '\\Alpha \\ beta')
  })

  it('does not encode inside code spans, autolinks, or raw tags', () => {
    assert.equal(encodeBackslashEscapes('`\\*code\\*`'), '`\\*code\\*`')
    assert.equal(encodeBackslashEscapes('<https://x.test/\\*>'), '<https://x.test/\\*>')
    assert.equal(encodeBackslashEscapes('<a href="\\*">'), '<a href="\\*">')
  })

  it('HTML-escapes decoded punctuation for safe emission', () => {
    assert.equal(decodeEscapedPunctuation(encodeBackslashEscapes('\\<\\&')), '&lt;&amp;')
  })

  it('canonicalizes raw and encoded label escapes identically', () => {
    const raw = 'foo\\!'
    assert.equal(canonicalizeEscapedPunctuation(raw), 'foo!')
    assert.equal(canonicalizeEscapedPunctuation(encodeBackslashEscapes(raw)), 'foo!')
  })
})

describe('renderMarkdown backslash escapes', () => {
  it('makes escaped delimiters inert (spec #14)', () => {
    const html = renderMarkdown('\\*not emphasized* \\[not a link](/foo) \\`not code`')
    assert.doesNotMatch(html, /<em>|<a |<code>/)
    assert.match(html, /\*not emphasized\*/)
    assert.match(html, /\[not a link\]\(\/foo\)/)
    assert.match(html, /`not code`/)
  })

  it('escaped backslash before emphasis stays literal (spec #15)', () => {
    assert.match(renderMarkdown('\\\\*emphasis*'), /\\<em>emphasis<\/em>/)
  })

  it('drops the backslash from escaped heading closers (spec #76)', () => {
    assert.match(renderMarkdown('### foo \\###'), /<h3>foo ###<\/h3>/)
  })

  it('decodes escapes in link destinations and titles (spec #22)', () => {
    const html = renderMarkdown('[foo](/bar\\* "ti\\*tle")')
    assert.match(html, /href="\/bar\*"/)
    assert.match(html, /title="ti\*tle"/)
  })

  it('matches reference labels across escaped forms', () => {
    const html = renderMarkdown('[foo\\!]\n\n[foo\\!]: /url\n')
    assert.match(html, /<a href="\/url"[^>]*>foo!<\/a>/)
  })

  it('keeps backslashes literal inside code spans', () => {
    assert.match(renderMarkdown('`\\[\\]`'), /<code>\\\[\\\]<\/code>/)
  })
})
