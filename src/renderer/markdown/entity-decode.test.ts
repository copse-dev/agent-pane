import '../../../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown } from './streaming.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { decodeSafeMarkdownEntities } from './escape.ts'

const metadataLine =
  '**Status:** Proposed &nbsp;&nbsp;|&nbsp;&nbsp; **Authors:** Engineering Guild &nbsp;&nbsp;|&nbsp;&nbsp; **Created:** 2025-01-25 &nbsp;&nbsp;|&nbsp;&nbsp; **Expires:** 2025-07-25'

describe('HTML entity decoding in prose', () => {
  it('decodes nbsp entities in at-rest markdown metadata lines', () => {
    const html = sanitizeRenderedMarkdown(
      renderMarkdown(`## RFC-042: Distributed Task Queue Protocol\n\n${metadataLine}\n`),
    )
    assert.doesNotMatch(html, /&amp;nbsp;/)
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(div.textContent, /&nbsp;/)
    assert.match(div.textContent, /Proposed[\u00A0\s]+\|[\u00A0\s]+Authors/)
  })

  it('decodes nbsp entities while streaming metadata lines', () => {
    const partial = `## RFC-042: Distributed Task Queue Protocol\n\n${metadataLine}`
    const html = renderStreamingMarkdown(partial)
    assert.doesNotMatch(html, /&amp;nbsp;/)
    assert.doesNotMatch(html, /\*\*Status:\*\*/)
    assert.match(html, /<strong>Status:<\/strong>/)
    assert.match(html, /stream-pending-paragraph/)
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(div.textContent, /&nbsp;/)
    assert.match(div.textContent, /Proposed[\u00A0\s]+\|[\u00A0\s]+Authors/)
  })

  it('never flashes partial nbsp entity text while streaming token-by-token', () => {
    const prefix = '## RFC-042: Distributed Task Queue Protocol\n\n**Status:** Proposed '
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    const entity = '&nbsp;&nbsp;|&nbsp;&nbsp; **Authors:** Guild'
    for (let i = 1; i <= entity.length; i++) {
      renderer.update(prefix + entity.slice(0, i))
      const text = host.textContent
      assert.doesNotMatch(text, /&nbsp/i, `flash at ${entity.slice(0, i)}`)
      assert.doesNotMatch(text, /&amp;/i)
    }
  })

  it('decodes double-encoded nbsp sequences', () => {
    assert.equal(decodeSafeMarkdownEntities('&amp;nbsp;'), '\u00A0')
    assert.equal(decodeSafeMarkdownEntities('&amp;nbsp;&amp;nbsp;'), '\u00A0\u00A0')
  })

  it('holds incomplete nbsp entity suffixes during streaming', () => {
    assert.equal(decodeSafeMarkdownEntities('Proposed &nbsp'), 'Proposed ')
    assert.equal(decodeSafeMarkdownEntities('Proposed &nbs'), 'Proposed ')
    assert.equal(decodeSafeMarkdownEntities('Proposed &amp;nb'), 'Proposed ')
  })
})
