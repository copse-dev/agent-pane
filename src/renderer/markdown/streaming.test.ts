// Uses jsdom (not the shared happy-dom setup) because these tests exercise the
// DOMPurify sanitizer, which needs a spec-complete DOM.
import '../../../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeEndsInOpenTable,
  pendingLineBelongsInTable,
  renderStreamingMarkdown,
  splitAtLastNewline,
  splitTableRow,
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
    assert.match(html, /<h4>Title<\/h4>/)
    assert.match(html, /<span class="stream-pending">- item<\/span>/)
    assert.doesNotMatch(html, /<li>- item<\/li>/)
  })

  it('formats each completed line as newlines arrive', () => {
    const first = renderStreamingMarkdown('## Title\n')
    const second = renderStreamingMarkdown('## Title\n- item one\n')
    assert.match(first, /<h4>Title<\/h4>/)
    assert.match(second, /<li>item one<\/li>/)
  })

  it('matches final markdown render once the last line ends', () => {
    const streaming = renderStreamingMarkdown('## Title\n- item one\n- item two\n')
    assert.match(streaming, /<h4>Title<\/h4>/)
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
})

describe('StreamingMarkdownRenderer (#119 incremental render)', () => {
  it('renders completed markdown and keeps the live tail in a separate span', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('## Title\n- item')
    const completed = host.querySelector('.stream-complete')!
    const pending = host.querySelector('.stream-pending')! as HTMLElement
    assert.match(completed.innerHTML, /<h4>Title<\/h4>/)
    assert.equal(pending.textContent, '- item')
    assert.equal(pending.hidden, false)
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

  it('hides the pending span when the tail is empty', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n')
    const pending = host.querySelector('.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
    assert.equal(pending.textContent, '')
  })

  it('renders an in-progress table row inside the table instead of below it', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2')

    const pendingRow = host.querySelector('tr.stream-pending-row')
    assert.ok(pendingRow)
    assert.equal(pendingRow?.querySelectorAll('td').length, 2)
    assert.deepEqual(
      [...pendingRow!.querySelectorAll('td')].map((td) => td.textContent),
      ['beta', '2'],
    )

    const pending = host.querySelector('.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
    assert.equal(pending.textContent, '')
  })

  it('updates pending table row cells in place across tokens', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('| A | B |\n| - | - |\n| one |')
    r.update('| A | B |\n| - | - |\n| one | two')
    const row = host.querySelector('tr.stream-pending-row')
    assert.deepEqual(
      [...row!.querySelectorAll('td')].map((td) => td.textContent),
      ['one', 'two'],
    )
    assert.strictEqual(host.querySelectorAll('tr.stream-pending-row').length, 1)
  })
})

describe('completeEndsInOpenTable', () => {
  it('is true after header and separator rows', () => {
    assert.equal(completeEndsInOpenTable('| A | B |\n| - | - |\n'), true)
  })

  it('is true after completed body rows', () => {
    assert.equal(completeEndsInOpenTable('| A | B |\n| - | - |\n| 1 | 2 |\n'), true)
  })

  it('is false after the table ends', () => {
    assert.equal(completeEndsInOpenTable('| A | B |\n| - | - |\n| 1 | 2 |\n\nNext'), false)
  })
})

describe('pendingLineBelongsInTable', () => {
  it('detects pipe rows continuing an open table', () => {
    assert.equal(pendingLineBelongsInTable('| A | B |\n| - | - |\n| 1 | 2 |\n', '| 3 | 4'), true)
  })

  it('does not absorb non-table pending lines', () => {
    assert.equal(pendingLineBelongsInTable('## Title\n', '- item'), false)
  })
})

describe('splitTableRow', () => {
  it('splits optional outer pipes', () => {
    assert.deepEqual(splitTableRow('| alpha | beta |'), ['alpha', 'beta'])
  })
})
