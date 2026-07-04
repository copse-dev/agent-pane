import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { revealFormingLink } from './render-pending-line.ts'
import { renderStreamingMarkdown } from './streaming.ts'
import { renderMarkdown } from './renderer.ts'

describe('revealFormingLink (#617)', () => {
  it('shows the label of a bare opening bracket', () => {
    assert.equal(revealFormingLink('[Click here'), 'Click here')
    assert.equal(revealFormingLink('intro [Click here'), 'intro Click here')
  })

  it('shows label only for an opened-but-unclosed destination', () => {
    assert.equal(revealFormingLink('[Click here](http://exam'), 'Click here')
    assert.equal(revealFormingLink('[a](/partial'), 'a')
  })

  it('leaves a complete link untouched', () => {
    assert.equal(
      revealFormingLink('[Click here](https://example.com)'),
      '[Click here](https://example.com)',
    )
  })

  it('only touches the trailing forming link, keeping earlier complete links', () => {
    assert.equal(revealFormingLink('see [a](/x) and [b'), 'see [a](/x) and b')
    assert.equal(revealFormingLink('see [a](/x) and [b](/y'), 'see [a](/x) and b')
  })

  it('leaves a closed-label shortcut/literal bracket alone', () => {
    assert.equal(revealFormingLink('array[0] index'), 'array[0] index')
    assert.equal(revealFormingLink('[ref]'), '[ref]')
  })

  it('ignores [ inside a code span or after a backslash', () => {
    assert.equal(revealFormingLink('use `arr[0]` here'), 'use `arr[0]` here')
    assert.equal(revealFormingLink('escaped \\[not a link'), 'escaped \\[not a link')
  })

  it('reveals image alt text without a broken <img>', () => {
    assert.equal(revealFormingLink('![diagram](/img'), 'diagram')
  })
})

describe('streaming link label end to end (#617)', () => {
  it('shows the label with no literal bracket or link for a bare [label', () => {
    const html = renderStreamingMarkdown('[Click here')
    assert.match(html, /Click here/)
    assert.doesNotMatch(html, /\[Click/)
    assert.doesNotMatch(html, /<a\b/)
  })

  it('shows label only while the URL is incomplete — no clickable partial href', () => {
    const html = renderStreamingMarkdown('[Click here](http://exam')
    assert.match(html, /Click here/)
    assert.doesNotMatch(html, /<a\b/)
    assert.doesNotMatch(html, /http:\/\/exam/)
  })

  it('upgrades to a real link once the URL completes', () => {
    const html = renderStreamingMarkdown('[Click here](https://example.com)')
    assert.match(html, /<a [^>]*href="https:\/\/example\.com"/)
    assert.match(html, />Click here<\/a>/)
  })

  it('does not flash a broken autolink for the partial URL across the whole stream', () => {
    const full = '[Click here](https://example.com)'
    for (let cut = 1; cut < full.length; cut++) {
      const html = renderStreamingMarkdown(full.slice(0, cut))
      // No <a> should appear until the closing ) arrives (last char).
      assert.doesNotMatch(
        html,
        /<a\b/,
        `unexpected link at prefix ${JSON.stringify(full.slice(0, cut))}`,
      )
    }
  })

  it('committed output (after newline) matches the at-rest render', () => {
    const streamed = renderStreamingMarkdown('[Click here](https://example.com)\n\n')
    const atRest = renderMarkdown('[Click here](https://example.com)')
    // Both should contain the same anchor markup once committed.
    assert.match(streamed, /<a [^>]*href="https:\/\/example\.com"[^>]*>Click here<\/a>/)
    assert.match(atRest, /<a [^>]*href="https:\/\/example\.com"[^>]*>Click here<\/a>/)
  })
})
