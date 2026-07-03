import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { renderStreamingMarkdown } from './streaming.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

const intro =
  "Here's another markdown example, this time styled as a **Meeting Minutes & Decision Record** to test nested lists, callout blocks, inline code, and structured metadata:\n"

describe('meeting minutes streaming regressions', () => {
  it('keeps intro visible while --- streams before a blank line', () => {
    const streaming = intro + '---'
    const blocks = tokenizeBlocks(streaming)
    assert.deepEqual(
      blocks.map((b) => `${b.kind}:${b.status}`),
      ['paragraph:complete', 'thematic_break:ambiguous'],
    )
    const html = renderStreamingMarkdown(streaming)
    assert.match(html, /<p>Here's another markdown example/)
    assert.match(html, /<span class="stream-pending">---<\/span>/)
    assert.doesNotMatch(html, /<h2>/)
  })

  it('shows ATX heading title in the pending tail without raw hash markers', () => {
    const partial = intro + '\n---\n\n# 📝 Meeting Minutes: Architecture Review #12'
    const html = renderStreamingMarkdown(partial)
    assert.doesNotMatch(html, /<h1>/)
    assert.match(html, /stream-pending-heading stream-pending-h1/)
    assert.match(html, />📝 Meeting Minutes: Architecture Review #12</)
    assert.doesNotMatch(html, />#\s*📝/)
  })

  it('streams ### subheadings without showing hash markers', () => {
    const partial = '## Summary\n\n### Architecture Highlights'
    const html = renderStreamingMarkdown(partial)
    assert.match(html, /<h2>Summary<\/h2>/)
    assert.doesNotMatch(html, /<h3>/)
    assert.match(html, /stream-pending-heading stream-pending-h3/)
    assert.match(html, />Architecture Highlights</)
    assert.doesNotMatch(html, />###\s/)
  })

  it('renders nbsp entities in metadata lines while streaming', () => {
    const title = intro + '\n---\n\n# 📝 Meeting Minutes: Architecture Review #12\n'
    const partial = title + '**Date:** 2025-01-22 &nbsp;&nbsp;|&nbsp;&nbsp; **Time'
    const html = renderStreamingMarkdown(partial)
    assert.match(html, /<strong>Date:<\/strong>/)
    assert.doesNotMatch(html, /&amp;nbsp;/)
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(div.textContent, /&nbsp;/)
    assert.match(div.textContent, /2025-01-22[\u00A0\s]+\|/)
  })

  it('hides inline pending when block lines are held with no visible output', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update(intro + '\n---\n\n')
    const pending = host.querySelector(':scope > span.stream-pending') as HTMLElement
    assert.equal(pending.hidden, true)
    assert.equal(pending.innerHTML, '')
  })

  it('streams attendee list items with bullets instead of raw markers', () => {
    const partial = intro + '\n---\n\n**Attendees:**\n- Alice Chen (Engineering Lead)'
    const html = renderStreamingMarkdown(partial)
    assert.match(html, /<ul><li class="stream-pending stream-pending-list-item[^"]*">Alice Chen/)
    assert.doesNotMatch(html, /stream-pending[^>]*>- Alice/)
  })
})
