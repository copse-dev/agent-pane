import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedentBlock, isIndentedHtmlBlock } from './indented-html.ts'
import { renderMarkdown } from './renderer.ts'
import { renderStreamingMarkdown } from './streaming.ts'

describe('isIndentedHtmlBlock (#616)', () => {
  it('recognizes an indented HTML block by its first tag', () => {
    assert.equal(isIndentedHtmlBlock('    <div>\n    <p>hi</p>\n    </div>'), true)
    assert.equal(isIndentedHtmlBlock('        <table>'), true)
  })

  it('does not treat ordinary indented code as HTML', () => {
    assert.equal(isIndentedHtmlBlock('    const x = 1\n    foo()'), false)
    assert.equal(isIndentedHtmlBlock('    2 < 3 is true'), false)
  })
})

describe('dedentBlock', () => {
  it('removes the shared minimum indentation', () => {
    assert.equal(dedentBlock('    <div>\n      <p>x</p>\n    </div>'), '<div>\n  <p>x</p>\n</div>')
  })
})

describe('indented HTML at top level (#616)', () => {
  it('renders indented HTML as escaped prose, not a <pre> code block', () => {
    const html = renderMarkdown('    <div>\n    <p>hi</p>\n    </div>')
    assert.doesNotMatch(html, /<pre>/)
    assert.match(html, /&lt;div&gt;/)
    assert.match(html, /&lt;p&gt;hi&lt;\/p&gt;/)
  })

  it('matches the un-indented raw-HTML rendering (policy parity)', () => {
    const indented = renderMarkdown('    <section>\n    text\n    </section>')
    const plain = renderMarkdown('<section>\ntext\n</section>')
    assert.equal(indented, plain)
  })

  it('still renders genuine indented code as <pre><code>', () => {
    const html = renderMarkdown('    const x = 1\n    return x')
    assert.match(html, /<pre><code>/)
    assert.match(html, /const x = 1/)
  })

  it('leaves indented HTML inside a list item as code (nested is unchanged)', () => {
    // 4 spaces of item indent + 4 for code = indented code inside the item.
    const html = renderMarkdown('- item\n\n        <div>nested</div>')
    assert.match(html, /<li>/)
    assert.match(html, /<pre><code>/)
    assert.match(html, /&lt;div&gt;nested&lt;\/div&gt;/)
  })

  it('applies on the streaming committed region too', () => {
    // Trailing blank line commits the HTML block; it must not be a <pre> dump.
    const html = renderStreamingMarkdown('    <div>\n    body\n    </div>\n\n')
    assert.doesNotMatch(html, /<pre>/)
    assert.match(html, /&lt;div&gt;/)
  })
})
