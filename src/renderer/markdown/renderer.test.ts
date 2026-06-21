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

  it('renders asterisk unordered lists', () => {
    const html = renderMarkdown('* alpha\n* beta')
    assert.match(html, /<ul>/)
    assert.match(html, /<li>alpha<\/li>/)
    assert.match(html, /<li>beta<\/li>/)
  })

  it('renders ordered lists with continuation paragraphs grouped into items', () => {
    const html = renderMarkdown(
      [
        "Here's a summary of the three changed files:",
        '',
        '1. `src/main/foo.ts`',
        '',
        'Introduces **foo** handling.',
        '',
        '2. `src/main/bar.ts`',
        '',
        'Worker thread for bar.',
      ].join('\n'),
    )
    assert.match(html, /<p>Here's a summary of the three changed files:<\/p>/)
    assert.match(html, /<ol>/)
    assert.match(
      html,
      /<li><code>src\/main\/foo\.ts<\/code><br><br>Introduces <strong>foo<\/strong> handling\.<\/li>/,
    )
    assert.match(html, /<li><code>src\/main\/bar\.ts<\/code><br><br>Worker thread for bar\.<\/li>/)
    assert.doesNotMatch(html, /<p>1\./)
    assert.doesNotMatch(html, /<p>2\./)
  })

  it('renders consecutive ordered items in one block', () => {
    const html = renderMarkdown('1. alpha\n2. beta')
    assert.match(html, /<ol><li>alpha<\/li><li>beta<\/li><\/ol>/)
  })

  it('keeps lists and headings outside paragraph wrappers', () => {
    const html = renderMarkdown(
      '### Section\n\n**Subheading:**\n- first\n\n**Other:**\n- second\n\n### Next\n- third',
    )
    assert.doesNotMatch(html, /<p>(?:(?!<\/p>)[\s\S])*<ul>/)
    assert.match(html, /<p><strong>Subheading:<\/strong><\/p>\s*<ul><li>first<\/li>\s*<\/ul>/)
    assert.match(html, /<h3>Next<\/h3>\s*<ul><li>third<\/li><\/ul>/)
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```ts\nconst x = 1\n```')
    assert.match(html, /<pre><code class="lang-ts">const x = 1<\/code><\/pre>/)
  })

  it('preserves comparison operators inside fenced code blocks', () => {
    const html = renderMarkdown('```ts\nif (a < b) return true\n```')
    assert.match(html, /if \(a &lt; b\) return true/)
    assert.doesNotMatch(html, /&lt;\/code>/)
  })

  it('renders mermaid fenced blocks as diagram placeholders', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```')
    assert.match(html, /<div class="mermaid-diagram mermaid-diagram--pending">/)
    assert.match(html, /<pre class="mermaid">graph TD/)
    assert.match(html, /A --> B/)
    assert.doesNotMatch(html, /<p>(?:(?!<\/p>)[\s\S])*<div class="mermaid-diagram">/)
  })

  it('does not apply markdown formatting inside mermaid fenced blocks', () => {
    const html = renderMarkdown(
      '```mermaid\nflowchart TB\n  **bold** --> _italic_\n  Renderer[Renderer (20+ modules)]\n```',
    )
    assert.match(html, /\*\*bold\*\* --> _italic_/)
    assert.match(html, /Renderer\[Renderer \(20\+ modules\)\]/)
    assert.doesNotMatch(html, /<strong>bold<\/strong>/)
    assert.doesNotMatch(html, /<em>italic<\/em>/)
  })

  it('keeps mermaid blocks intact when the diagram div has modifier classes', () => {
    const html = renderMarkdown('Intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nOutro')
    assert.match(html, /<div class="mermaid-diagram mermaid-diagram--pending">/)
    assert.doesNotMatch(html, /<p>(?:(?!<\/p>)[\s\S])*<strong>/)
    assert.match(html, /<p>Intro<\/p>/)
    assert.match(html, /<p>Outro<\/p>/)
  })

  it('escapes HTML-like content inside fenced code blocks', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>/)
  })

  it('renders GFM tables on final render', () => {
    const html = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
    assert.match(html, /<table>/)
    assert.match(html, /<th>A<\/th>/)
    assert.match(html, /<td>2<\/td>/)
  })

  it('renders thematic breaks as horizontal rules', () => {
    const html = renderMarkdown('Above\n\n---\n\nBelow')
    assert.match(html, /<hr>/)
    assert.match(html, /<p>Above<\/p>/)
    assert.match(html, /<p>Below<\/p>/)
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

  it('renders asterisk italic without breaking snake_case in code spans', () => {
    const html = renderMarkdown(
      'there *is* semantic search via `search_codebase` and `grep_search`',
    )
    assert.match(html, /there <em>is<\/em> semantic search/)
    assert.match(html, /<code>search_codebase<\/code>/)
    assert.match(html, /<code>grep_search<\/code>/)
    assert.doesNotMatch(html, /<code>search<em>/)
  })

  it('renders explore-style summary markdown with headings, hr, and lists', () => {
    const html = renderMarkdown(
      [
        'Here is the complete summary:',
        '',
        '---',
        '',
        "## Search Routing Summary ('search-routing.ts')",
        '',
        "### 1. Classification ('classifySearchQuery')",
        '',
        '**File:** `src/main/services/search-routing.ts`',
        '',
        '- **Semantic path** — `search_codebase`',
        '- **Grep path** — `grep_search`',
        '',
        '### 2. Execution',
        '',
        '- Read `search-routing.ts`',
      ].join('\n'),
    )
    assert.doesNotMatch(html, /<p>(?:(?!<\/p>)[\s\S])*<ul>/)
    assert.match(html, /<hr>/)
    assert.match(html, /<h4>Search Routing Summary/)
    assert.match(html, /<h3>1\. Classification/)
    assert.match(html, /<code>search_codebase<\/code>/)
    assert.match(html, /<h3>2\. Execution<\/h3>\s*<ul>/)
  })
})
