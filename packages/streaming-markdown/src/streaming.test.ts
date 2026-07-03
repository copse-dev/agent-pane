// Uses jsdom (not the shared happy-dom setup) because these tests exercise the
// DOMPurify sanitizer, which needs a spec-complete DOM.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pendingHoldIndex,
  renderStreamingMarkdown,
  splitAtLastNewline,
  splitForStreaming,
  StreamingMarkdownRenderer,
} from './streaming.ts'

describe('splitAtLastNewline', () => {
  it('keeps all content pending when no newline has arrived yet', () => {
    assert.deepEqual(splitAtLastNewline('## Title'), {
      complete: '',
      pending: '## Title',
    })
  })

  it('marks lines ending with newline as complete', () => {
    assert.deepEqual(splitAtLastNewline('## Title\n- item\n'), {
      complete: '## Title\n- item\n',
      pending: '',
    })
  })

  it('leaves the final in-progress line pending', () => {
    assert.deepEqual(splitAtLastNewline('## Title\n- item'), {
      complete: '## Title\n',
      pending: '- item',
    })
  })
})

describe('renderStreamingMarkdown', () => {
  it('renders completed lines as markdown while the tail streams list body text', () => {
    const html = renderStreamingMarkdown('## Title\n- item')
    assert.match(html, /<h2>Title<\/h2>/)
    assert.match(
      html,
      /<ul><li class="stream-pending stream-pending-list-item[^"]*">item<\/li><\/ul>/,
    )
    assert.doesNotMatch(html, /stream-pending[^>]*>- item/)
    assert.doesNotMatch(html, /<li>item<\/li>/)
  })

  it('renders complete inline bold markup on the pending line', () => {
    const html = renderStreamingMarkdown(
      'Review intro\n**Recent commits to main (all auto-bump PRs):**',
    )
    assert.match(html, /<p class="stream-pending stream-pending-paragraph[^"]*">/)
    assert.match(html, /<strong>Recent commits to main \(all auto-bump PRs\):<\/strong>/)
    assert.doesNotMatch(html, /\*\*Recent commits/)
  })

  it('formats each completed line as newlines arrive', () => {
    const first = renderStreamingMarkdown('## Title\n')
    const second = renderStreamingMarkdown('## Title\n- item one\n')
    assert.match(first, /<h2>Title<\/h2>/)
    assert.match(second, /<li>item one<\/li>/)
  })

  it('matches final markdown render once the last line ends', () => {
    const streaming = renderStreamingMarkdown('## Title\n- item one\n- item two\n')
    assert.match(streaming, /<h2>Title<\/h2>/)
    assert.match(streaming, /<li>item one<\/li>/)
    assert.match(streaming, /<li>item two<\/li>/)
    assert.doesNotMatch(streaming, /stream-pending/)
  })

  it('fully escapes the in-progress tail, including & and quotes (#115)', () => {
    const html = renderStreamingMarkdown('done\n<img src=x onerror=alert(1)> "a" & b')
    assert.match(html, /<p class="stream-pending stream-pending-paragraph[^"]*">/)
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;a&quot; &amp; b/)
  })

  it('escapes raw HTML in completed lines while streaming', () => {
    const html = renderStreamingMarkdown('<script>alert(1)</script>\n')
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('sanitizes a dangerous element emitted on the pending line (L3 defense-in-depth)', () => {
    // The renderer re-emits <img> for artifact tags. The DOMPurify allowlist now
    // keeps the locked-down `remote-artifact-image` form (hydrated post-sanitize)
    // but the dangerous src/onerror payload must never reach innerHTML.
    const html = renderStreamingMarkdown('done\n<img src="artifacts/x.png" onerror="alert(1)">')
    assert.match(html, /<p class="stream-pending stream-pending-paragraph[^"]*">/)
    assert.match(html, /<img class="remote-artifact-image"/)
    assert.doesNotMatch(html, /onerror/)
    assert.doesNotMatch(html, /src=/)
  })
})

describe('pendingHoldIndex (defer unresolved inline markup)', () => {
  const visible = (s: string): string => s.slice(0, pendingHoldIndex(s))

  it('does not cut a line with no inline delimiters', () => {
    assert.equal(pendingHoldIndex('plain text'), 'plain text'.length)
  })

  it('keeps fully resolved emphasis', () => {
    assert.equal(pendingHoldIndex('**bold** done'), '**bold** done'.length)
    assert.equal(pendingHoldIndex('**Recent commits:**'), '**Recent commits:**'.length)
  })

  it('holds an unclosed bold run and everything after it', () => {
    assert.equal(visible('intro **bold'), 'intro ')
    assert.equal(visible('**bold'), '')
  })

  it('holds a bare trailing delimiter run before its lookahead arrives', () => {
    assert.equal(visible('intro **'), 'intro ')
    assert.equal(visible('a *'), 'a ')
  })

  it('holds the nearest-opener case rather than mis-bolding the first run', () => {
    // `**foo **bar baz**` resolves to `**foo <strong>bar baz</strong>`; until the
    // first `**` closes we hold from it so we never show `<strong>foo </strong>`.
    assert.equal(visible('**foo **bar baz**'), '')
  })

  it('holds a whitespace-flanked closer instead of pairing it', () => {
    assert.equal(visible('**Recent commits **(all'), '')
  })

  it('does not treat underscores inside a word as emphasis', () => {
    assert.equal(pendingHoldIndex('see some_long_identifier'), 'see some_long_identifier'.length)
  })

  it('does not hold a dangling closer with no opener', () => {
    assert.equal(pendingHoldIndex('host**: value'), 'host**: value'.length)
    assert.equal(pendingHoldIndex('2 ** 3 stays literal'), '2 ** 3 stays literal'.length)
  })

  it('holds an unclosed inline code span', () => {
    assert.equal(visible('run `npm test'), 'run ')
    assert.equal(pendingHoldIndex('run `npm test` now'), 'run `npm test` now'.length)
  })

  it('ignores emphasis delimiters inside a closed code span', () => {
    assert.equal(pendingHoldIndex('use `a**b` here'), 'use `a**b` here'.length)
  })
})

describe('splitForStreaming (block-granularity emphasis)', () => {
  it('holds an open emphasis span across a soft line break', () => {
    assert.deepEqual(splitForStreaming('intro **bold\ntext'), {
      complete: 'intro ',
      pending: '**bold\ntext',
    })
  })

  it('commits resolved emphasis across soft breaks once closed', () => {
    const html = renderStreamingMarkdown('intro **bold\ntext**')
    assert.match(html, /<span class="stream-pending(?: stream-pending-paragraph)?">/)
    assert.match(html, /<strong>bold text<\/strong>/)
    assert.doesNotMatch(html, /\*\*/)
  })

  it('falls back to line split when emphasis is resolved', () => {
    assert.deepEqual(splitForStreaming('done\nplain tail'), {
      complete: 'done\n',
      pending: 'plain tail',
    })
  })
})

describe('renderStreamingMarkdown (holds unresolved bold)', () => {
  it('never emits a half-open bold tag on the pending line', () => {
    const html = renderStreamingMarkdown('done\nintro **bold text')
    assert.doesNotMatch(html, /<strong>/)
    assert.doesNotMatch(html, /\*\*/)
  })

  it('holds unresolved bold on a pending list line without showing marker or **', () => {
    const html = renderStreamingMarkdown('done\n- **MCP support')
    assert.doesNotMatch(html, /\*\*/)
    assert.doesNotMatch(html, /stream-pending[^>]*>-/)
    assert.doesNotMatch(html, /<span class="stream-pending stream-pending-list-item">/)
  })

  it('renders resolved bold on a pending list line without waiting for newline', () => {
    const html = renderStreamingMarkdown('done\n- **MCP support** — notes')
    assert.match(html, /<li class="stream-pending stream-pending-list-item[^"]*">/)
    assert.match(html, /<strong>MCP support<\/strong>/)
    assert.doesNotMatch(html, /\*\*/)
    assert.doesNotMatch(html, /stream-pending[^>]*>-/)
    assert.doesNotMatch(html, /<li>/)
  })

  it('keeps earlier list items committed while the next item streams', () => {
    const html = renderStreamingMarkdown('- item one\n- item two')
    assert.match(html, /<li>item one<\/li>/)
    assert.match(
      html,
      /<ul><li>item one<\/li><li class="stream-pending stream-pending-list-item[^"]*">item two<\/li><\/ul>/,
    )
    assert.doesNotMatch(html, /stream-pending[^>]*>-/)
  })

  it('renders lazy list continuations inside the open item without a fake bullet', () => {
    const html = renderStreamingMarkdown('- parent\n    - child item')
    assert.match(
      html,
      /<li>parent<span class="stream-pending stream-pending-list-continuation[^"]*"> {2}- child item<\/span><\/li>/,
    )
    assert.doesNotMatch(html, /stream-pending-list-item[^"]*">child item/)
    assert.doesNotMatch(html, /stream-pending[^>]*>- child/)
  })

  it('renders lazy continuations under a prior list item without a fake bullet', () => {
    const html = renderStreamingMarkdown('**Attendees:**\n- Alice\n    - Bob')
    assert.match(
      html,
      /<li>Alice<span class="stream-pending stream-pending-list-continuation[^"]*"> {2}- Bob<\/span><\/li>/,
    )
    assert.doesNotMatch(html, /stream-pending-list-item[^"]*">Bob/)
  })

  it('renders tight lazy continuation text inside the open list item', () => {
    const html = renderStreamingMarkdown('- alpha\n  beta')
    assert.match(
      html,
      /<li>alpha<span class="stream-pending stream-pending-list-continuation[^"]*"> beta<\/span><\/li>/,
    )
    assert.doesNotMatch(html, /stream-pending-paragraph/)
  })

  it('hides incomplete list markers until whitespace follows the dash', () => {
    const html = renderStreamingMarkdown('done\n-item')
    assert.doesNotMatch(html, /-item/)
    assert.doesNotMatch(html, />-/)
    const withSpace = renderStreamingMarkdown('done\n- item')
    assert.match(withSpace, /stream-pending-list-item[^"]*">item/)
  })

  it('still renders valid nested sublists at 0-3 spaces as list items', () => {
    const html = renderStreamingMarkdown('- parent\n  - child item')
    assert.match(html, /<li>parent<ul>/)
    assert.match(
      html,
      /<ul><li>parent<ul><li class="stream-pending stream-pending-list-item[^"]*">child item<\/li><\/ul><\/li><\/ul>/,
    )
  })

  it('streams ATX headings without raw hash markers on the pending line', () => {
    const html = renderStreamingMarkdown('## Title\n### Section name')
    assert.match(html, /<h2>Title<\/h2>/)
    assert.match(html, /stream-pending-heading stream-pending-h3/)
    assert.match(html, />Section name</)
    assert.doesNotMatch(html, />###\s/)
  })

  it('hides incomplete ATX heading markers until title text follows', () => {
    assert.doesNotMatch(renderStreamingMarkdown('## Title\n###'), />###\s/)
    assert.match(renderStreamingMarkdown('## Title\n### Name'), />Name</)
  })

  it('streams blockquotes without raw > markers on the pending line', () => {
    const html = renderStreamingMarkdown('intro\n> quoted text')
    assert.match(html, /<blockquote class="stream-pending stream-pending-blockquote[^"]*">/)
    assert.match(html, /<p>quoted text<\/p>/)
    assert.doesNotMatch(html, /&gt; quoted/)
  })

  it('hides bare blockquote markers until body text follows', () => {
    assert.doesNotMatch(renderStreamingMarkdown('intro\n>'), /stream-pending-blockquote/)
    assert.match(renderStreamingMarkdown('intro\n> note'), /quoted text|note/)
  })

  it('shows a forming table with header cells while the separator streams', () => {
    const html = renderStreamingMarkdown('intro\n| Path | Role |')
    assert.match(html, /<p>intro<\/p>/)
    assert.match(html, /<table class="stream-table-forming">/)
    assert.match(html, /<th>Path<\/th>/)
    assert.match(html, /<th>Role<\/th>/)
    assert.doesNotMatch(html, /stream-pending/)
  })

  it('shows a forming fenced code block with highlighting while streaming', () => {
    const html = renderStreamingMarkdown('intro\n```ts\nconst x = 1')
    assert.match(html, /<p>intro<\/p>/)
    assert.match(html, /<pre class="stream-fence-forming"><code class="hljs lang-typescript">/)
    assert.match(html, /hljs-keyword/)
    assert.match(html, /const/)
    assert.doesNotMatch(html, /stream-pending/)
    assert.doesNotMatch(html, /```/)
  })

  it('shows a pending mermaid source shell while the fence is open', () => {
    const html = renderStreamingMarkdown('```mermaid\ngraph TD\n  A --> B')
    assert.match(
      html,
      /<div class="mermaid-diagram mermaid-diagram--pending stream-fence-forming">/,
    )
    assert.match(html, /<pre class="mermaid">graph TD/)
    assert.doesNotMatch(html, /stream-pending/)
  })

  it('renders a table once header and separator are complete', () => {
    const html = renderStreamingMarkdown('intro\n| A | B |\n| - | - |\n')
    assert.match(html, /<table>/)
    assert.match(html, /<th>A<\/th>/)
  })

  it('appends a pending body row to a committed table instead of raw pipe text', () => {
    const html = renderStreamingMarkdown(
      '| Path | Role |\n| - | - |\n| src/ | Application source |\n| tests/e2e/ | WebdriverIO specs |',
    )
    assert.match(html, /<table>/)
    assert.match(html, /<tr class="stream-pending-row">/)
    assert.match(html, /<td>tests\/e2e\/<\/td>/)
    assert.match(html, /<td>WebdriverIO specs<\/td>/)
    assert.doesNotMatch(html, /stream-pending[^>]*>\|/)
    assert.doesNotMatch(html, /stream-forming/)
    assert.doesNotMatch(html, /stream-table-forming/)
  })

  it('appends the first body row to a committed header table while streaming', () => {
    const html = renderStreamingMarkdown('| H1 | H2 |\n| - | - |\n| **x** | y')
    assert.match(html, /<table>/)
    assert.match(html, /<tr class="stream-pending-row">/)
    assert.match(html, /<td><strong>x<\/strong><\/td>/)
    assert.doesNotMatch(html, /stream-table-forming/)
  })

  it('does not mis-bold a whitespace-flanked closer mid-stream', () => {
    const html = renderStreamingMarkdown('done\n**Recent commits **(all')
    assert.doesNotMatch(html, /<strong>Recent commits/)
    assert.doesNotMatch(html, /\*\*/)
  })

  it('reveals the bold once the closing delimiter arrives', () => {
    const html = renderStreamingMarkdown('done\nintro **bold text**')
    assert.match(html, /<strong>bold text<\/strong>/)
  })
})

describe('StreamingMarkdownRenderer (#119 incremental render)', () => {
  it('renders block pending inside stream-complete for open list lines', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('## Title\n- item')
    const completed = host.querySelector('.stream-complete')
    const blockPending = completed?.querySelector('.stream-pending-block') as HTMLElement
    const inlinePending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.ok(completed)
    assert.ok(blockPending)
    assert.match(completed.innerHTML, /<h2>Title<\/h2>/)
    assert.equal(blockPending.textContent, 'item')
    assert.ok(blockPending.classList.contains('stream-pending-list-item'))
    assert.equal(inlinePending.hidden, true)
  })

  it('renders inline markdown in the block pending tail without rebuilding completed content', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n**Recent commits:**')
    const blockPending = host.querySelector('.stream-pending-block') as HTMLElement
    assert.equal(blockPending.textContent, 'Recent commits:')
    assert.match(blockPending.innerHTML, /<strong>Recent commits:<\/strong>/)
  })

  it('reuses the same block pending node across tokens (no full rebuild)', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('Hello')
    const firstPending = host.querySelector('.stream-pending-block')
    r.update('Hello wor')
    r.update('Hello world')
    assert.strictEqual(host.querySelector('.stream-pending-block'), firstPending)
    assert.equal((firstPending as HTMLElement).textContent, 'Hello world')
    assert.equal(host.querySelectorAll('.stream-complete').length, 1)
  })

  it('only re-renders the committed region when a newline arrives', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('line one')
    const completed = host.querySelector('.stream-complete') as HTMLElement
    assert.match(completed.innerHTML, /stream-pending-block/)
    r.update('line one\n')
    assert.match(completed.innerHTML, /line one/)
    assert.doesNotMatch(completed.innerHTML, /stream-pending-block/)
    assert.strictEqual(host.querySelector('.stream-complete'), completed)
  })

  it('escapes the live tail rather than injecting markup', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('safe\n<img src=x onerror=alert(1)>')
    assert.equal(host.querySelectorAll('img').length, 0)
    const pending = host.querySelector('.stream-pending-block') as HTMLElement
    assert.equal(pending.textContent, '<img src=x onerror=alert(1)>')
  })

  it('sanitizes a dangerous element on the live tail before innerHTML (L3)', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n<img src="artifacts/x.png" onerror="alert(1)">')
    // The artifact image survives in its locked-down form (class-gated, no src
    // until hydration); the dangerous src/onerror payload is stripped.
    const img = host.querySelector('img')
    assert.ok(img)
    assert.equal(img.getAttribute('class'), 'remote-artifact-image')
    assert.equal(img.getAttribute('src'), null)
    const pending = host.querySelector('.stream-pending-block') as HTMLElement
    assert.doesNotMatch(pending.innerHTML, /onerror/)
  })

  it('forward-passes a forming table in the DOM while header streams', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('intro\n| Path | Role |')
    const forming = host.querySelector('.stream-forming table.stream-table-forming')
    assert.ok(forming instanceof Element && forming.tagName === 'TABLE')
    assert.match(host.querySelector('.stream-complete')?.innerHTML ?? '', /<p>intro<\/p>/)
    const headers = forming.querySelectorAll('thead th')
    assert.equal(headers.length, 2)
    assert.equal(headers[0]?.textContent, 'Path')
    assert.equal(headers[1]?.textContent, 'Role')
    const pending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
  })

  it('forward-passes a forming fenced code block in the DOM while body streams', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('intro\n```ts\nconst x = 1')
    const pre = host.querySelector('.stream-forming pre.stream-fence-forming')
    assert.ok(pre instanceof Element && pre.tagName === 'PRE')
    assert.match(pre.querySelector('code')?.innerHTML ?? '', /hljs-keyword/)
    assert.match(host.querySelector('.stream-complete')?.innerHTML ?? '', /<p>intro<\/p>/)
    const pending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
  })

  it('renders inline markdown in a streaming table body cell', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('| A | B |\n| - | - |\n| **bold** | `code`')
    const table = host.querySelector('.stream-complete table')
    assert.ok(table instanceof Element && table.tagName === 'TABLE')
    const row = table.querySelector('tr.stream-pending-row')
    assert.ok(row instanceof Element && row.tagName === 'TR')
    assert.match(row.innerHTML, /<strong>bold<\/strong>/)
    assert.match(row.innerHTML, /<code>code<\/code>/)
    const forming = host.querySelector('.stream-forming table')
    assert.equal(forming, null)
  })

  it('appends a pending body row to a committed table in the incremental renderer', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update(
      '| Path | Role |\n| - | - |\n| src/ | Application source |\n| tests/e2e/ | WebdriverIO specs |',
    )
    const table = host.querySelector('.stream-complete table')
    assert.ok(table instanceof Element && table.tagName === 'TABLE')
    const pendingRow = table.querySelector('tr.stream-pending-row')
    assert.ok(pendingRow instanceof Element && pendingRow.tagName === 'TR')
    assert.match(pendingRow.textContent, /tests\/e2e\//)
    assert.match(pendingRow.textContent, /WebdriverIO specs/)
    const inlinePending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(inlinePending.hidden, true)
    const forming = host.querySelector('.stream-forming')
    assert.ok(forming instanceof HTMLElement)
    assert.equal(forming.hidden, true)
  })

  it('hides the inline pending span when the tail is empty', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n')
    const pending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
    assert.equal(pending.textContent, '')
  })
})
