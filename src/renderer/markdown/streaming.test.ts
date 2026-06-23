// Uses jsdom (not the shared happy-dom setup) because these tests exercise the
// DOMPurify sanitizer, which needs a spec-complete DOM.
import '../../../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  markStreamingEnterAnimations,
  renderStreamingMarkdown,
  splitAtLastNewline,
  STREAM_ENTER_CLASS,
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

  it('marks a new table and each new body row with stream-enter', () => {
    const host = document.createElement('div')
    host.classList.add('is-streaming')
    const r = new StreamingMarkdownRenderer(host)

    r.update('| Name | Value |\n| --- | --- |\n')
    const table = host.querySelector('table')
    assert.ok(table?.classList.contains(STREAM_ENTER_CLASS))
    assert.equal(host.querySelectorAll('tbody tr').length, 0)

    r.update('| Name | Value |\n| --- | --- |\n| alpha | 1 |\n')
    const firstRow = host.querySelector('tbody tr')
    assert.ok(firstRow?.classList.contains(STREAM_ENTER_CLASS))

    r.update('| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n')
    const rows = host.querySelectorAll('tbody tr')
    assert.equal(rows.length, 2)
    assert.equal(rows[1]?.classList.contains(STREAM_ENTER_CLASS), true)
    assert.equal(rows[0]?.classList.contains(STREAM_ENTER_CLASS), false)
  })
})

describe('markStreamingEnterAnimations', () => {
  it('tracks table appearance and row growth independently', () => {
    const completed = document.createElement('div')
    completed.innerHTML =
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'

    const afterFirst = markStreamingEnterAnimations(completed, false, 0)
    assert.equal(afterFirst.hadTable, true)
    assert.equal(afterFirst.tableBodyRowCount, 1)
    assert.ok(completed.querySelector('table')?.classList.contains(STREAM_ENTER_CLASS))
    assert.ok(completed.querySelector('tbody tr')?.classList.contains(STREAM_ENTER_CLASS))

    completed.innerHTML =
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>'
    const afterSecond = markStreamingEnterAnimations(
      completed,
      afterFirst.hadTable,
      afterFirst.tableBodyRowCount,
    )
    assert.equal(afterSecond.tableBodyRowCount, 2)
    const rows = completed.querySelectorAll('tbody tr')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.classList.contains(STREAM_ENTER_CLASS), false)
    assert.equal(rows[1]?.classList.contains(STREAM_ENTER_CLASS), true)
  })
})
