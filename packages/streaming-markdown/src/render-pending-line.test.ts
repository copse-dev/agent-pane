import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderPendingLine } from './render-pending-line.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

describe('renderPendingLine list streaming edge cases', () => {
  it('does not treat **bold** as an incomplete list marker', () => {
    const html = sanitizeRenderedMarkdown(
      renderPendingLine('**Recent commits to main (all auto-bump PRs):**'),
    )
    assert.match(html, /<strong>Recent commits/)
  })

  it('does not treat --- as an incomplete list marker', () => {
    const html = sanitizeRenderedMarkdown(renderPendingLine('---'))
    assert.equal(html, '---')
  })

  it('hides -item until whitespace follows the marker', () => {
    assert.equal(renderPendingLine('-item'), '')
    assert.match(sanitizeRenderedMarkdown(renderPendingLine('- item')), /item/)
  })

  it('dedents lazy continuations using the open item first line', () => {
    const html = sanitizeRenderedMarkdown(
      renderPendingLine('    - child item', { openListItemFirstLine: '- parent' }),
    )
    assert.match(html, / {2}- child item/)
  })

  it('strips ATX hash markers and renders heading title inline', () => {
    const html = sanitizeRenderedMarkdown(renderPendingLine('### Architecture Highlights'))
    assert.match(html, /Architecture Highlights/)
    assert.doesNotMatch(html, /###/)
  })

  it('strips blockquote markers and renders body inline', () => {
    const html = sanitizeRenderedMarkdown(renderPendingLine('> quoted text'))
    assert.match(html, /quoted text/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('hides bare blockquote markers until body text follows', () => {
    assert.equal(renderPendingLine('>'), '')
    assert.equal(renderPendingLine('> '), '')
    assert.match(sanitizeRenderedMarkdown(renderPendingLine('> note')), /note/)
  })

  it('hides incomplete ATX heading markers until title text follows', () => {
    assert.equal(renderPendingLine('###'), '')
    assert.equal(renderPendingLine('## '), '')
    assert.match(sanitizeRenderedMarkdown(renderPendingLine('## Title')), /Title/)
  })
})
