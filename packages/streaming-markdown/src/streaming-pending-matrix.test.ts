import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown } from './streaming.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

/**
 * Reference matrix for every streaming "row" / pending-line shape the renderer
 * handles. When adding a new pending construct, extend this table and the
 * README streaming-hold section.
 */
describe('streaming pending row matrix', () => {
  it('paragraph: block pending with inline markdown, no raw markup', () => {
    const html = renderStreamingMarkdown('done\n**bold** tail')
    assert.match(html, /<p class="stream-pending stream-pending-paragraph[^"]*">/)
    assert.match(html, /<strong>bold<\/strong> tail/)
  })

  it('unordered list item: hides - marker, uses list-item chrome', () => {
    const html = renderStreamingMarkdown('done\n- item text')
    assert.match(
      html,
      /<ul><li class="stream-pending stream-pending-list-item[^"]*">item text<\/li><\/ul>/,
    )
    assert.doesNotMatch(html, />-\s*item/)
  })

  it('ordered list item: hides 1. marker, exposes data-ordered-marker', () => {
    const html = renderStreamingMarkdown('done\n1. first step')
    assert.match(html, /stream-pending-ordered-item/)
    assert.match(html, /data-ordered-marker="1"/)
    assert.match(html, />first step</)
    assert.doesNotMatch(html, />1\.\s/)
  })

  it('ATX heading: hides # run, uses heading chrome per level', () => {
    const html = renderStreamingMarkdown('## Done\n\n### Section title')
    assert.match(html, /<h2>Done<\/h2>/)
    assert.match(
      html,
      /<div class="stream-pending stream-pending-heading stream-pending-h3[^"]*" data-heading-level="3">Section title<\/div>/,
    )
    assert.doesNotMatch(html, />###\s/)
  })

  it('incomplete ATX heading marker: hidden until title text follows', () => {
    const html = renderStreamingMarkdown('## Done\n\n###')
    assert.doesNotMatch(html, /stream-pending-heading/)
    assert.doesNotMatch(html, />###/)
  })

  it('nested sublist item: indented - marker hidden, top-level list-item chrome', () => {
    const html = renderStreamingMarkdown('- parent\n  - child item')
    assert.match(html, /<li>parent<ul>/)
    assert.match(
      html,
      /<ul><li>parent<ul><li class="stream-pending stream-pending-list-item[^"]*">child item<\/li><\/ul><\/li><\/ul>/,
    )
    assert.doesNotMatch(html, /stream-pending-list-continuation/)
  })

  it('lazy list continuation: plain text inside open li without fake bullet row', () => {
    const html = renderStreamingMarkdown('- parent\n  continued text')
    assert.match(html, /stream-pending-list-continuation/)
    assert.match(html, /continued text/)
    assert.doesNotMatch(html, /stream-pending-list-item[^"]*">continued/)
  })

  it('thematic break: escaped plain text until line completes', () => {
    const html = renderStreamingMarkdown('done\n---')
    assert.match(html, /<span class="stream-pending">---<\/span>/)
    assert.doesNotMatch(html, /<hr>/)
  })

  it('blockquote: hides > marker and uses blockquote chrome with inline markdown', () => {
    const html = renderStreamingMarkdown('done\n> quoted text')
    assert.match(html, /<blockquote class="stream-pending stream-pending-blockquote[^"]*">/)
    assert.match(html, /<p>quoted text<\/p>/)
    assert.doesNotMatch(html, /&gt;/)
    assert.doesNotMatch(html, /> quoted/)
  })

  it('blockquote: hides bare > until body text follows', () => {
    assert.doesNotMatch(renderStreamingMarkdown('done\n>'), /stream-pending-blockquote/)
    assert.match(renderStreamingMarkdown('done\n> note'), /stream-pending-blockquote/)
  })

  it('forming table header row: th cells with inline markdown, no raw pipes in cells', () => {
    const html = renderStreamingMarkdown('intro\n| **A** | `code` |')
    assert.match(html, /<table class="stream-table-forming">/)
    assert.match(html, /<th><strong>A<\/strong><\/th>/)
    assert.match(html, /<th><code>code<\/code><\/th>/)
    assert.doesNotMatch(html, /stream-pending-list-item/)
  })

  it('forming table body row: tr.stream-pending-row with parsed cells', () => {
    const html = renderStreamingMarkdown('| H1 | H2 |\n| - | - |\n| **x** | y')
    assert.match(html, /<tr class="stream-pending-row">/)
    assert.match(html, /<td><strong>x<\/strong><\/td>/)
    assert.match(html, /<td>y<\/td>/)
  })

  it('committed table body row: pending row appended to tbody, not raw pipe span', () => {
    const html = renderStreamingMarkdown(
      '| Path | Role |\n| - | - |\n| src/ | Application source |\n| tests/e2e/ | WebdriverIO specs |',
    )
    assert.match(html, /<table>/)
    assert.match(html, />src\//)
    assert.match(html, /<tr class="stream-pending-row">/)
    assert.match(html, />tests\/e2e\//)
    assert.match(html, />WebdriverIO specs</)
    assert.doesNotMatch(html, /stream-pending[^>]*>\|/)
    assert.doesNotMatch(html, /stream-table-forming/)
  })

  it('nbsp in pending prose: decoded, never literal &nbsp;', () => {
    const html = renderStreamingMarkdown(
      'done\n**Status:** ok &nbsp;&nbsp;|&nbsp;&nbsp; **Team:** x',
    )
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(html, /&amp;nbsp;/)
    assert.doesNotMatch(div.textContent, /&nbsp;/)
  })

  it('incremental renderer: heading pending is a div with data-heading-level', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('## Done\n\n### Section title')
    const block = host.querySelector('.stream-pending-block') as HTMLElement
    assert.ok(block)
    assert.equal(block.tagName, 'DIV')
    assert.ok(block.classList.contains('stream-pending-heading'))
    assert.ok(block.classList.contains('stream-pending-h3'))
    assert.equal(block.getAttribute('data-heading-level'), '3')
    assert.equal(block.textContent, 'Section title')
    const inline = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(inline.hidden, true)
  })

  it('incremental renderer: list pending is a native li inside ul', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n- item')
    const block = host.querySelector('.stream-pending-block') as HTMLElement
    assert.equal(block.tagName, 'LI')
    assert.ok(block.classList.contains('stream-pending-list-item'))
    assert.equal(block.parentElement?.tagName, 'UL')
  })

  it('incremental renderer: blockquote pending uses blockquote element with p wrapper', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('done\n> quoted text')
    const block = host.querySelector('.stream-pending-blockquote') as HTMLElement
    assert.ok(block)
    assert.equal(block.tagName, 'BLOCKQUOTE')
    assert.equal(block.querySelector('p')?.textContent, 'quoted text')
    const inline = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(inline.hidden, true)
  })
})
