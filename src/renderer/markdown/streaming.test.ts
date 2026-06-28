// Uses jsdom (not the shared happy-dom setup) because these tests exercise the
// DOMPurify sanitizer, which needs a spec-complete DOM.
import '../../../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pendingHoldIndex,
  renderStreamingMarkdown,
  splitAtLastNewline,
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
  it('renders completed lines as markdown while the tail stays plain', () => {
    const html = renderStreamingMarkdown('## Title\n- item')
    assert.match(html, /<h2>Title<\/h2>/)
    assert.match(html, /<span class="stream-pending">- item<\/span>/)
    assert.doesNotMatch(html, /<li>- item<\/li>/)
  })

  it('renders complete inline bold markup on the pending line', () => {
    const html = renderStreamingMarkdown(
      'Review intro\n**Recent commits to main (all auto-bump PRs):**',
    )
    assert.match(html, /<span class="stream-pending">/)
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
    assert.match(html, /<span class="stream-pending">/)
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
    assert.match(html, /<span class="stream-pending">/)
    assert.match(html, /<img class="remote-artifact-image"/)
    assert.doesNotMatch(html, /onerror/)
    assert.doesNotMatch(html, /src=/)
  })
})

describe('pendingHoldIndex (defer unresolved inline markup)', () => {
  const visible = (s: string) => s.slice(0, pendingHoldIndex(s))

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

describe('renderStreamingMarkdown (holds unresolved bold)', () => {
  it('never emits a half-open bold tag on the pending line', () => {
    const html = renderStreamingMarkdown('done\nintro **bold text')
    assert.doesNotMatch(html, /<strong>/)
    assert.doesNotMatch(html, /\*\*/)
    assert.match(html, /<span class="stream-pending">intro\s*<\/span>/)
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
  it('renders completed markdown and keeps the live tail in a separate span', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('## Title\n- item')
    const completed = host.querySelector('.stream-complete')!
    const pending = host.querySelector('.stream-pending')! as HTMLElement
    assert.match(completed.innerHTML, /<h2>Title<\/h2>/)
    assert.equal(pending.textContent, '- item')
    assert.equal(pending.hidden, false)
  })

  it('renders inline markdown in the live tail without rebuilding completed content', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n**Recent commits:**')
    const pending = host.querySelector('.stream-pending') as HTMLElement
    assert.equal(pending.textContent, 'Recent commits:')
    assert.match(pending.innerHTML, /<strong>Recent commits:<\/strong>/)
  })

  it('reuses the same completed node across tokens (no full rebuild)', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('Hello')
    const firstPending = host.querySelector('.stream-pending')
    r.update('Hello wor')
    r.update('Hello world')
    // Same nodes are mutated in place; no newline yet so completed stays empty.
    assert.strictEqual(host.querySelector('.stream-pending'), firstPending)
    assert.equal((firstPending as HTMLElement).textContent, 'Hello world')
    assert.equal(host.querySelectorAll('.stream-complete').length, 1)
  })

  it('only re-renders the completed region when a newline arrives', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('line one')
    const completed = host.querySelector('.stream-complete') as HTMLElement
    assert.equal(completed.innerHTML, '')
    r.update('line one\n')
    assert.match(completed.innerHTML, /line one/)
    assert.strictEqual(host.querySelector('.stream-complete'), completed)
  })

  it('escapes the live tail rather than injecting markup', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('safe\n<img src=x onerror=alert(1)>')
    assert.equal(host.querySelectorAll('img').length, 0)
    const pending = host.querySelector('.stream-pending') as HTMLElement
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
    assert.equal(img!.getAttribute('class'), 'remote-artifact-image')
    assert.equal(img!.getAttribute('src'), null)
    const pending = host.querySelector('.stream-pending') as HTMLElement
    assert.doesNotMatch(pending.innerHTML, /onerror/)
  })

  it('hides the pending span when the tail is empty', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n')
    const pending = host.querySelector('.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
    assert.equal(pending.textContent, '')
  })
})
