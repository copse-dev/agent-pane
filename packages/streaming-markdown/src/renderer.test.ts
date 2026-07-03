import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'

describe('renderMarkdown', () => {
  it('renders headings on their own lines', () => {
    const html = renderMarkdown('## Section\n\nBody text')
    assert.match(html, /<h2>Section<\/h2>/)
    assert.match(html, /<p>Body text<\/p>/)
  })

  it('preserves single newlines inside paragraphs (CommonMark soft breaks)', () => {
    const html = renderMarkdown('line one\nline two')
    assert.match(html, /line one[\n]line two/)
    assert.doesNotMatch(html, /line one<br>line two/)
  })

  it('does not apply hard line breaks inside raw HTML tags (CommonMark #642)', () => {
    const html = renderMarkdown('<a href="foo  \nbar">\n')
    assert.equal(html, '<p><a href="foo  \nbar"></p>')
    assert.doesNotMatch(html, /<br>/)
  })

  it('preserves blank-line paragraph breaks', () => {
    const html = renderMarkdown('first paragraph\n\nsecond paragraph')
    assert.match(html, /<p>first paragraph<\/p>/)
    assert.match(html, /<p>second paragraph<\/p>/)
  })

  it('strips HTML comments from prose but keeps them in fenced code', () => {
    const html = renderMarkdown(
      '<!-- template hint -->\n\nVisible text\n\n```html\n<!-- keep -->\n```',
    )
    assert.doesNotMatch(html, /template hint/)
    assert.match(html, /<p>Visible text<\/p>/)
    assert.match(html, /keep/)
    assert.doesNotMatch(html, /template hint/)
  })

  it('renders unordered lists', () => {
    const html = renderMarkdown('- alpha\n- beta')
    assert.match(html, /<ul>/)
    assert.match(html, /<li>alpha<\/li>/)
    assert.match(html, /<li>beta<\/li>/)
    assert.match(html, /<ul><li>alpha<\/li><li>beta<\/li><\/ul>/)
  })

  it('groups unordered list items separated by blank lines into one loose list (#314)', () => {
    const html = renderMarkdown('- alpha\n\n- beta\n\n- gamma')
    assert.match(
      html,
      /<ul><li><p>alpha<\/p><\/li><li><p>beta<\/p><\/li><li><p>gamma<\/p><\/li><\/ul>/,
    )
    assert.doesNotMatch(html, /<\/ul>\s*<ul>/)
  })

  it('ends a list when blank is followed by under-indented text (#255, #276)', () => {
    const html255 = renderMarkdown('- one\n\n two\n')
    assert.match(html255, /<ul><li>one<\/li><\/ul>\s*<p>two<\/p>/)
    const html276 = renderMarkdown('-    foo\n\n  bar\n')
    assert.match(html276, /<ul><li>foo<\/li><\/ul>\s*<p>bar<\/p>/)
  })

  it('continues a list item across a blank with lazy indentation (#256)', () => {
    const html = renderMarkdown('- one\n\n  two\n')
    assert.match(html, /<ul><li><p>one<\/p>\s*<p>two<\/p><\/li><\/ul>/)
  })

  it('splits unordered lists when the marker character changes (#301)', () => {
    const html = renderMarkdown('- foo\n- bar\n+ baz\n')
    assert.match(html, /<ul><li>foo<\/li><li>bar<\/li><\/ul>\s*<ul><li>baz<\/li><\/ul>/)
  })

  it('emits ordered list start attributes (#265, #268)', () => {
    const html265 = renderMarkdown('123456789. ok\n')
    assert.match(html265, /<ol start="123456789"><li>ok<\/li><\/ol>/)
    const html268 = renderMarkdown('003. ok\n')
    assert.match(html268, /<ol start="3"><li>ok<\/li><\/ol>/)
  })

  it('treats a 10-digit ordered marker as a paragraph (#266)', () => {
    const html = renderMarkdown('1234567890. not ok\n')
    assert.match(html, /<p>1234567890\. not ok<\/p>/)
    assert.doesNotMatch(html, /<ol/)
  })

  it('renders asterisk unordered lists', () => {
    const html = renderMarkdown('* alpha\n* beta')
    assert.match(html, /<ul>/)
    assert.match(html, /<li>alpha<\/li>/)
    assert.match(html, /<li>beta<\/li>/)
  })

  it('renders relative markdown links and reference definitions', () => {
    const html = renderMarkdown(
      '[Experiment Framework v2](/docs/experiments/v2.md)\n\n[intro][ref]\n\n[ref]: /docs "guide"\n',
    )
    assert.match(html, /href="\/docs\/experiments\/v2\.md"[^>]*data-workspace-link="true"/)
    assert.match(
      html,
      /<a href="\/docs"[^>]*data-workspace-link="true"[^>]*title="guide"[^>]*>intro<\/a>/,
    )
    assert.doesNotMatch(html, /\[ref\]:/)
  })

  it('renders markdown links in prose and ordered lists', () => {
    const html = renderMarkdown(
      'See [PR #204](https://github.com/org/repo/pull/204) for details.\n\n' +
        '1. [PR #205](https://github.com/org/repo/pull/205) — draft fix\n' +
        '2. [PR #188](https://github.com/org/repo/pull/188) — UI change',
    )
    assert.match(
      html,
      /<a href="https:\/\/github\.com\/org\/repo\/pull\/204" target="_blank" rel="noopener noreferrer" data-browser-link="true">PR #204<\/a>/,
    )
    assert.match(
      html,
      /<li><a href="https:\/\/github\.com\/org\/repo\/pull\/205"[^>]*>PR #205<\/a> — draft fix<\/li>/,
    )
    assert.match(
      html,
      /<li><a href="https:\/\/github\.com\/org\/repo\/pull\/188"[^>]*>PR #188<\/a> — UI change<\/li>/,
    )
  })

  it('leaves unsafe link schemes as literal markdown', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    assert.doesNotMatch(html, /<a /)
    assert.match(html, /\[click me\]\(javascript:alert\(1\)\)/)
  })

  it('does not render links inside inline code', () => {
    const html = renderMarkdown('Use `[text](http://x)` literally')
    assert.match(html, /<code>\[text\]\(http:\/\/x\)<\/code>/)
    assert.doesNotMatch(html, /<a /)
  })

  it('auto-links bare HTTP URLs outside code spans', () => {
    const html = renderMarkdown('Open https://example.com/docs, not `https://example.com/raw`.')
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer" data-browser-link="true">https:\/\/example\.com\/docs<\/a>,/,
    )
    assert.match(html, /<code>https:\/\/example\.com\/raw<\/code>/)
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
    // Apostrophes are HTML-encoded by the order-independent text encoder (#115).
    assert.match(html, /<p>Here&#39;s a summary of the three changed files:<\/p>/)
    assert.match(html, /<ol>/)
    assert.match(
      html,
      /<li><p><code>src\/main\/foo\.ts<\/code><\/p>\s*<p>Introduces <strong>foo<\/strong> handling\.<\/p><\/li>/,
    )
    assert.match(
      html,
      /<li><p><code>src\/main\/bar\.ts<\/code><\/p>\s*<p>Worker thread for bar\.<\/p><\/li>/,
    )
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
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    assert.match(html, /hljs-keyword/)
    assert.match(html, /hljs-number/)
    assert.match(html, /const/)
  })

  it('strips leading and trailing blank lines inside fenced code blocks', () => {
    const html = renderMarkdown('```ts\n\nconst x = 1\n\n```')
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    assert.match(html, /hljs-keyword/)
    assert.match(html, /const/)
  })

  it('preserves comparison operators inside fenced code blocks', () => {
    const html = renderMarkdown('```ts\nif (a < b) return true\n```')
    assert.match(html, /\(a &lt; b\)/)
    assert.match(html, /hljs-keyword/)
    assert.match(html, /hljs-literal/)
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

  it('highlights HTML-like fenced blocks without injecting raw tags', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    assert.match(html, /hljs-tag/)
    assert.match(html, /script/)
    assert.doesNotMatch(html, /<script>/)
  })

  it('renders GFM tables on final render', () => {
    const html = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
    assert.match(html, /<table>/)
    assert.match(html, /<th>A<\/th>/)
    assert.match(html, /<td>2<\/td>/)
  })

  it('renders 3-column tables with PR/branch/description layout', () => {
    const html = renderMarkdown(
      '| PR | Branch | Description |\n|----|--------|-------------|\n| #11 | `jkt/vendor` | Vendor visual-plan. 18 files, +2,315 lines. |\n| #10 | `jkt/okf` | On-device retrieval. 26 files, +5,604 lines. |',
    )
    assert.match(html, /<table>/)
    assert.match(html, /<th>PR<\/th>/)
    assert.match(html, /<th>Branch<\/th>/)
    assert.match(html, /<th>Description<\/th>/)
    assert.match(html, /<td>#11<\/td>/)
    assert.match(html, /<td>#10<\/td>/)
    assert.match(html, /<td>Vendor visual-plan\./)
    assert.match(html, /<td>On-device retrieval\./)
  })

  it('renders thematic breaks as horizontal rules', () => {
    const html = renderMarkdown('Above\n\n---\n\nBelow')
    assert.match(html, /<hr>/)
    assert.match(html, /<p>Above<\/p>/)
    assert.match(html, /<p>Below<\/p>/)
  })

  it('treats spaced marker runs as thematic breaks, not lists or emphasis', () => {
    for (const rule of ['* * *', '- - -', '_ _ _', ' **  * ** * ** * **']) {
      const html = renderMarkdown(`Above\n\n${rule}\n\nBelow`)
      assert.match(html, /<hr>/, `expected <hr> for ${JSON.stringify(rule)}`)
      assert.doesNotMatch(html, /<em>/, `unexpected <em> for ${JSON.stringify(rule)}`)
      assert.doesNotMatch(html, /<li>/, `unexpected <li> for ${JSON.stringify(rule)}`)
    }
  })

  it('renders multi-backtick code spans with interior backticks', () => {
    const html = renderMarkdown('`` foo ` bar ``')
    assert.match(html, /<code>foo ` bar<\/code>/)
    assert.doesNotMatch(html, /<code><\/code>/)
  })

  it('strips a single surrounding space inside code spans', () => {
    assert.match(renderMarkdown('` `` `'), /<code>``<\/code>/)
    assert.match(renderMarkdown('`  ``  `'), /<code> `` <\/code>/)
  })

  it('collapses interior line endings in multi-line code spans to spaces', () => {
    const html = renderMarkdown('``\nfoo\nbar\n``')
    assert.match(html, /<code>foo bar<\/code>/)
    assert.doesNotMatch(html, /<code>[^<]*<br>/)
  })

  it('leaves an unmatched backtick run as literal text', () => {
    const html = renderMarkdown('```foo``')
    assert.doesNotMatch(html, /<code>/)
    assert.match(html, /```foo``/)
  })

  it('does not strip interior newlines from multi-line content', () => {
    const input = '## Repo summary\n\n### index.html\nMain app file.\n\n### tests\n14 passed.'
    const html = renderMarkdown(input)
    assert.match(html, /<h2>Repo summary<\/h2>/)
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
    assert.match(html, /<h2>Search Routing Summary/)
    assert.match(html, /<h3>1\. Classification/)
    assert.match(html, /<code>search_codebase<\/code>/)
    assert.match(html, /<h3>2\. Execution<\/h3>\s*<ul>/)
  })

  it('bolds list labels after table cells with glob paths in inline code', () => {
    const html = renderMarkdown(
      [
        '## Tests',
        '',
        '| Path | Role |',
        '| --- | --- |',
        '| **`src/**/*.test.ts`** | Unit tests (bundled into `dist-test/`) |',
        '| **`tests/e2e/`** | WebdriverIO e2e tests (tool display, markdown rendering, etc.) |',
        '',
        '## Architecture Notes',
        '',
        '- **Shell permissions**: `src/main/services/permission-policy.ts` — sandbox policy',
        '- **MCP host**: connects via `.cursor/mcp.json` or `~/.cursor/mcp.json`',
      ].join('\n'),
    )
    assert.match(html, /<strong><code>src\/\*\*\/\*\.test\.ts<\/code><\/strong>/)
    assert.match(html, /<li><strong>Shell permissions<\/strong>:/)
    assert.match(html, /<li><strong>MCP host<\/strong>:/)
    assert.doesNotMatch(html, /MCP host\*\*:/)
    assert.doesNotMatch(html, /<li><\/strong>/)
  })

  it('bolds emphasis inside every table cell without leaking ** across cells', () => {
    // Regression for #469: parseTables emitted the whole table on one line, so
    // the global bold pass paired `**` across cells (via the code span in each
    // description), leaving the first/last `**Label**` cells as literal markers.
    const html = renderMarkdown(
      [
        '| Area | Details |',
        '|---|---|',
        '| **Storage** | `okf-memory-store.ts` — saves notes |',
        '| **Agent tools** | `memory-tools.ts` — two tools |',
        '| **Read-only mode** | `recall` allowed; `remember` denied |',
        '| **Tests** | Unit tests for persistence and search |',
      ].join('\n'),
    )
    assert.match(html, /<td><strong>Storage<\/strong><\/td>/)
    assert.match(html, /<td><strong>Agent tools<\/strong><\/td>/)
    assert.match(html, /<td><strong>Read-only mode<\/strong><\/td>/)
    assert.match(html, /<td><strong>Tests<\/strong><\/td>/)
    // No stray literal markers survive in any cell.
    assert.doesNotMatch(html, /\*\*/)
    // Inline code in description cells is still rendered.
    assert.match(html, /<code>okf-memory-store\.ts<\/code>/)
    assert.match(html, /<code>recall<\/code>/)
  })

  it('renders bold and inline code together in a header cell', () => {
    const html = renderMarkdown('| **Name** | Note |\n| --- | --- |\n| `id` | ok |')
    assert.match(html, /<th><strong>Name<\/strong><\/th>/)
    assert.match(html, /<td><code>id<\/code><\/td>/)
  })

  it('bolds captions that mix inline code and prose', () => {
    const html = renderMarkdown('**`css-new-tab.png` — NTP rendered end-to-end**')

    assert.match(html, /<strong><code>css-new-tab\.png<\/code> — NTP rendered end-to-end<\/strong>/)
    assert.doesNotMatch(html, /\*\*/)
  })

  it('bolds the label, not the body, when a stray trailing ** follows a code span', () => {
    // Odd `**` count: the label closer must not pair with the stray trailing
    // delimiter across the code span (which would bold the wrong half and leave
    // `**MCP support` literal).
    const html = renderMarkdown(
      '- **MCP support** — Can host servers (configured via `.cursor/mcp.json`).**',
    )
    assert.match(html, /<li><strong>MCP support<\/strong> — Can host servers/)
    assert.match(html, /<code>\.cursor\/mcp\.json<\/code>/)
    assert.doesNotMatch(html, /\*\*MCP support/)
    assert.doesNotMatch(html, /<strong> — Can host/)
  })

  it('renders a simple blockquote', () => {
    const html = renderMarkdown('> This is a quoted line')
    assert.match(html, /<blockquote>/)
    assert.match(html, /<p>This is a quoted line<\/p>/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('renders multi-line blockquotes with a soft line break', () => {
    const html = renderMarkdown('> First line\n> Second line')
    assert.match(html, /<blockquote>/)
    assert.match(html, /First line[\n]Second line/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('groups consecutive blockquote paragraphs into one blockquote element', () => {
    const html = renderMarkdown('> First paragraph\n\n> Second paragraph')
    assert.match(html, /<blockquote>/)
    assert.match(html, /<p>First paragraph<\/p>/)
    assert.match(html, /<p>Second paragraph<\/p>/)
    assert.doesNotMatch(html, /<\/blockquote>[\s\S]*<blockquote>/)
  })

  it('renders inline formatting inside blockquotes', () => {
    const html = renderMarkdown('> **Important**: read this `carefully`')
    assert.match(html, /<blockquote>/)
    assert.match(html, /<strong>Important<\/strong>/)
    assert.match(html, /<code>carefully<\/code>/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('does not render > inside fenced code as a blockquote', () => {
    const html = renderMarkdown('```\n> not a blockquote\n```')
    assert.doesNotMatch(html, /<blockquote>/)
    // The line stays inside the code block as escaped text. highlight.js may wrap
    // individual tokens in <span>s, so assert the escaped `>` marker survives
    // within <pre><code> rather than matching the whole literal line.
    assert.match(html, /<pre><code[\s\S]*&gt; not/)
  })

  it('renders blockquote between surrounding prose without bleeding', () => {
    const html = renderMarkdown('Before\n\n> quoted text\n\nAfter')
    assert.match(html, /<p>Before<\/p>/)
    assert.match(html, /<blockquote><p>quoted text<\/p><\/blockquote>/)
    assert.match(html, /<p>After<\/p>/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('keeps a lazy continuation line inside the blockquote (no leaked &gt;)', () => {
    const html = renderMarkdown('> line one\nlazy continuation')
    assert.match(html, /<blockquote>/)
    assert.match(html, /line one[\n]lazy continuation/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('renders nested blockquotes as nested elements', () => {
    const html = renderMarkdown('> > quoted')
    assert.match(html, /<blockquote><blockquote><p>quoted<\/p><\/blockquote><\/blockquote>/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('does not emit an empty blockquote for a bare > line', () => {
    const html = renderMarkdown('>')
    assert.doesNotMatch(html, /<blockquote><\/blockquote>/)
    assert.doesNotMatch(html, /&gt;/)
  })

  it('drops a bare > separator line within a blockquote without leaking &gt;', () => {
    const html = renderMarkdown('> first\n>\n> second')
    assert.match(html, /<blockquote>/)
    assert.match(html, /first/)
    assert.match(html, /second/)
    assert.doesNotMatch(html, /&gt;/)
    assert.doesNotMatch(html, /<p><\/p>/)
  })
})

describe('renderMarkdown sanitization (#115)', () => {
  it('escapes raw HTML tags from untrusted text so no live element is emitted', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  })

  it('allows only remote artifact image tags as inert image placeholders', () => {
    const html = renderMarkdown(
      '<img alt="C-S-S New Tab Page rendered" src="/opt/cursor/artifacts/screenshots/css-new-tab.png" />',
    )

    assert.match(html, /<img class="remote-artifact-image"/)
    assert.match(html, /data-remote-artifact-path="artifacts\/screenshots\/css-new-tab\.png"/)
    assert.match(html, /alt="C-S-S New Tab Page rendered"/)
    assert.doesNotMatch(html, /src="/)
  })

  it('wraps a block that contains but cannot be split around a block element without infinite recursion', () => {
    // The rendered artifact <img> makes CONTAINS_BLOCK_RE match, but the block
    // does not start with a block element, so splitBlockElements returns the
    // single unchanged block. wrapParagraphBlock must wrap it as a paragraph and
    // stop rather than recurse on the identical block forever (the guard in
    // wrapParagraphBlock). Reaching this assertion at all proves no infinite loop.
    const html = renderMarkdown(
      'Inline <img src="/opt/cursor/artifacts/screenshots/x.png"> trailing text',
    )
    assert.match(html, /^<p>Inline <img class="remote-artifact-image"[^>]*> trailing text<\/p>$/)
  })

  it('escapes script tags rather than executing them', () => {
    const html = renderMarkdown('<script>alert(document.cookie)</script>')
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('decodes entities to inert text that can never reconstruct markup', () => {
    // CommonMark decodes &lt;script&gt; to the literal text "<script>", which
    // must be emitted HTML-escaped — never as a live tag.
    const html = renderMarkdown('AT&T &lt;script&gt; &amp; more')
    assert.match(html, /AT&amp;T &lt;script&gt; &amp; more/)
    assert.doesNotMatch(html, /<script>/)
  })

  it('encodes quotes so untrusted text cannot break out into an attribute', () => {
    const html = renderMarkdown(`say "hi" and 'bye'`)
    assert.match(html, /&quot;hi&quot;/)
    assert.match(html, /&#39;bye&#39;/)
  })

  it('renders benign raw inline tags but keeps attributed/structural markup escaped', () => {
    const html = renderMarkdown(
      ['| H |', '| - |', '| <b>x</b> <b onclick="p()">y</b> <div>z</div> |'].join('\n'),
    )
    assert.match(html, /<td><b>x<\/b>/)
    // The attributed opener stays escaped; its bare closer passes through and
    // the DOMPurify sink drops the orphan tag.
    assert.match(html, /&lt;b onclick=&quot;p\(\)&quot;&gt;y/)
    assert.match(html, /&lt;div&gt;z&lt;\/div&gt;/)
  })

  it('keeps injected markup escaped inside inline code spans', () => {
    const html = renderMarkdown('`<svg onload=alert(1)>`')
    assert.match(html, /<code>&lt;svg onload=alert\(1\)&gt;<\/code>/)
    assert.doesNotMatch(html, /<svg/)
  })

  it('is order-independent: escaping & before < produces no decodable markup', () => {
    // A naive ordered encoder that runs < before & could double-process; ensure
    // the single-pass encoder leaves exactly one level of encoding.
    const html = renderMarkdown('5 < 6 && 7 > 3')
    assert.match(html, /5 &lt; 6 &amp;&amp; 7 &gt; 3/)
  })
})

describe('renderMarkdown CommonMark structure fixes', () => {
  it('maps setext headings to h1/h2 like their ATX equivalents', () => {
    assert.match(renderMarkdown('Title\n=====\n'), /<h1>Title<\/h1>/)
    assert.match(renderMarkdown('Section\n---\n'), /<h2>Section<\/h2>/)
  })

  it('treats an all-hash ATX title as a bare closing sequence', () => {
    assert.match(renderMarkdown('### ###'), /<h3><\/h3>/)
    assert.match(renderMarkdown('## foo ##'), /<h2>foo<\/h2>/)
  })

  it('renders backslash-before-newline as a hard break', () => {
    assert.match(renderMarkdown('foo\\\nbar'), /<p>foo<br>bar<\/p>/)
  })

  it('collapses an escaped backslash to one literal backslash with a soft break', () => {
    assert.match(renderMarkdown('foo\\\\\nbar'), /<p>foo\\\nbar<\/p>/)
  })

  it('strips continuation-line indentation after a hard break', () => {
    assert.match(renderMarkdown('foo  \n     bar'), /<p>foo<br>bar<\/p>/)
  })

  it('applies hard breaks inside emphasis spans', () => {
    assert.match(renderMarkdown('*foo  \nbar*'), /<em>foo<br>bar<\/em>/)
    assert.match(renderMarkdown('*foo\\\nbar*'), /<em>foo<br>bar<\/em>/)
  })

  it('passes benign raw inline HTML through and keeps it escaped in code spans', () => {
    const html = renderMarkdown('a <del>gone</del> x<sub>1</sub> <kbd>Ctrl</kbd> line<br>next')
    assert.match(html, /<del>gone<\/del>/)
    assert.match(html, /<sub>1<\/sub>/)
    assert.match(html, /<kbd>Ctrl<\/kbd>/)
    assert.match(html, /line<br>next/)
    assert.match(renderMarkdown('`<del>x</del>`'), /<code>&lt;del&gt;x&lt;\/del&gt;<\/code>/)
  })

  it('does not hard-break inside code spans or at the end of a block', () => {
    assert.match(renderMarkdown('`foo  \nbar`'), /<code>foo {3}bar<\/code>/)
    assert.doesNotMatch(renderMarkdown('foo\\'), /<br>/)
    assert.doesNotMatch(renderMarkdown('foo  \n'), /<br>/)
  })
})

describe('renderMarkdown list-item block content (#595)', () => {
  it('nests indented sublists inside their parent item', () => {
    const html = renderMarkdown('- a\n  - b\n- c\n')
    assert.match(html, /<li>a\s*<ul><li>b<\/li><\/ul><\/li>/)
  })

  it('renders fenced code and blockquotes inside list items', () => {
    const html = renderMarkdown('1. foo\n\n   ```\n   bar\n   ```\n\n   > bam\n')
    assert.match(html, /<li><p>foo<\/p>\s*<pre><code[^>]*>bar/)
    assert.match(html, /<blockquote><p>bam<\/p><\/blockquote><\/li>/)
  })

  it('renders document-level indented code blocks', () => {
    assert.match(
      renderMarkdown('    code line\n\npara\n'),
      /<pre><code>code line\n<\/code><\/pre>\s*<p>para<\/p>/,
    )
  })

  it('renders indented code inside a list item (spec #270)', () => {
    assert.match(
      renderMarkdown('- foo\n\n      bar\n'),
      /<li><p>foo<\/p>\s*<pre><code>bar\n<\/code><\/pre><\/li>/,
    )
  })

  it('keeps lazy under-indented markers as paragraph text (spec #312)', () => {
    const html = renderMarkdown('- a\n - b\n  - c\n   - d\n    - e\n')
    assert.match(html, /<li>d - e<\/li>/)
    assert.doesNotMatch(html, /<li>d<ul>/)
  })

  it('indented code cannot interrupt a paragraph (spec #225)', () => {
    assert.match(renderMarkdown('aaa\n    bbb\n'), /<p>aaa\n\s*bbb<\/p>/)
  })
})

describe('renderMarkdown tab handling', () => {
  it('treats a leading tab as four columns of code indent, preserving interior tabs (spec 1/2)', () => {
    assert.equal(renderMarkdown('\tfoo\tbaz\t\tbim\n'), '<pre><code>foo\tbaz\t\tbim\n</code></pre>')
    assert.equal(
      renderMarkdown('  \tfoo\tbaz\t\tbim\n'),
      '<pre><code>foo\tbaz\t\tbim\n</code></pre>',
    )
  })

  it('continues an indented code block across a tab-indented line (spec 8)', () => {
    assert.equal(renderMarkdown('    foo\n\tbar\n'), '<pre><code>foo\nbar\n</code></pre>')
  })

  it('accepts a tab as the ATX heading separator (spec 10)', () => {
    assert.equal(renderMarkdown('#\tFoo\n'), '<h1>Foo</h1>')
    assert.equal(renderMarkdown('#Foo\n'), '<p>#Foo</p>')
  })
})
