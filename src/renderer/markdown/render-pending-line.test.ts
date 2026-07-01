import '../../../tests/setup-dom-jsdom.ts'
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
})
