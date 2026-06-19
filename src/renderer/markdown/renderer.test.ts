import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'

describe('renderMarkdown', () => {
  it('renders headings on their own lines', () => {
    const html = renderMarkdown('## Section\n\nBody text')
    assert.match(html, /<h4>Section<\/h4>/)
    assert.match(html, /<p>Body text<\/p>/)
  })

  it('converts single newlines inside paragraphs to line breaks', () => {
    const html = renderMarkdown('line one\nline two')
    assert.match(html, /line one<br>line two/)
  })

  it('preserves blank-line paragraph breaks', () => {
    const html = renderMarkdown('first paragraph\n\nsecond paragraph')
    assert.match(html, /<p>first paragraph<\/p>/)
    assert.match(html, /<p>second paragraph<\/p>/)
  })

  it('renders unordered lists', () => {
    const html = renderMarkdown('- alpha\n- beta')
    assert.match(html, /<ul>/)
    assert.match(html, /<li>alpha<\/li>/)
    assert.match(html, /<li>beta<\/li>/)
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```ts\nconst x = 1\n```')
    assert.match(html, /<pre><code class="lang-ts">const x = 1<\/code><\/pre>/)
  })

  it('renders GFM tables on final render', () => {
    const html = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
    assert.match(html, /<table>/)
    assert.match(html, /<th>A<\/th>/)
    assert.match(html, /<td>2<\/td>/)
  })

  it('does not strip interior newlines from multi-line content', () => {
    const input = '## Repo summary\n\n### index.html\nMain app file.\n\n### tests\n14 passed.'
    const html = renderMarkdown(input)
    assert.match(html, /<h4>Repo summary<\/h4>/)
    assert.match(html, /<h3>index\.html<\/h3>/)
    assert.match(html, /Main app file\./)
    assert.match(html, /<h3>tests<\/h3>/)
    assert.match(html, /14 passed\./)
  })
})
