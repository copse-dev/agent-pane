import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInlineSpans } from './inline-spans.ts'

describe('renderInlineSpans (unified inline pipeline)', () => {
  it('renders emphasis around markdown links after the delimiter stack', () => {
    assert.equal(
      renderInlineSpans('*foo [bar](https://example.com)*'),
      '<em>foo <a href="https://example.com" target="_blank" rel="noopener noreferrer" data-browser-link="true">bar</a></em>',
    )
    assert.equal(
      renderInlineSpans('**foo [bar](https://example.com)**'),
      '<strong>foo <a href="https://example.com" target="_blank" rel="noopener noreferrer" data-browser-link="true">bar</a></strong>',
    )
  })

  it('renders emphasis inside link labels', () => {
    assert.equal(
      renderInlineSpans('[**bar**](https://example.com)'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer" data-browser-link="true"><strong>bar</strong></a>',
    )
    assert.equal(
      renderInlineSpans('*foo [*bar*](https://example.com)*'),
      '<em>foo <a href="https://example.com" target="_blank" rel="noopener noreferrer" data-browser-link="true"><em>bar</em></a></em>',
    )
  })

  it('bolds inline code with glob asterisks without crossing the code shield', () => {
    assert.equal(
      renderInlineSpans('**<code>src/**/*.ts</code>**'),
      '<strong><code>src/**/*.ts</code></strong>',
    )
  })

  it('bolds captions that mix inline code and trailing prose', () => {
    assert.equal(
      renderInlineSpans('**<code>css-new-tab.png</code> — NTP rendered end-to-end**'),
      '<strong><code>css-new-tab.png</code> — NTP rendered end-to-end</strong>',
    )
  })
})
