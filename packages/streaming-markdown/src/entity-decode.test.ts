import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown } from './streaming.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { decodeSafeMarkdownEntities } from './escape.ts'

const metadataLine =
  '**Status:** Proposed &nbsp;&nbsp;|&nbsp;&nbsp; **Authors:** Engineering Guild &nbsp;&nbsp;|&nbsp;&nbsp; **Created:** 2025-01-25 &nbsp;&nbsp;|&nbsp;&nbsp; **Expires:** 2025-07-25'

const sprintMetadataLine =
  '**Sprint Dates:** 2025-01-13 → 2025-01-27 &nbsp;&nbsp;|&nbsp;&nbsp; **Team:** Platform Squad &nbsp;&nbsp;|&nbsp;&nbsp; **Velocity:** 42/55 points'

const sprintRetroDoc = `Here's another markdown example — this time a **Sprint Retrospective** with different formatting patterns:

---

# 📊 Sprint 24 Retrospective

${sprintMetadataLine}

---

## Sprint Summary

| Metric | Planned | Completed | % Done |
|--------|---------|-----------|:------:|
| Story Points | 55 | 42 | 76% |
`

function assertNoVisibleNbsp(html: string, label: string): void {
  const div = document.createElement('div')
  div.innerHTML = html
  assert.doesNotMatch(div.textContent, /&nbsp;/, `${label}: textContent`)
  assert.doesNotMatch(html, /&amp;nbsp;/, `${label}: html`)
}

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

  it('decodes nbsp on pending ATX heading titles', () => {
    const partial = `# 📊 Sprint 24 Retrospective &nbsp;&nbsp;|&nbsp;&nbsp; **Team:**`
    const html = sanitizeRenderedMarkdown(renderStreamingMarkdown(partial))
    assertNoVisibleNbsp(html, 'ambiguous-atx')
    assert.match(html, /stream-pending-heading/)
    assert.doesNotMatch(html, /# 📊/)
  })

  it('decodes nbsp in sprint retrospective metadata at rest and while streaming', () => {
    assertNoVisibleNbsp(sanitizeRenderedMarkdown(renderMarkdown(sprintRetroDoc)), 'sprint-at-rest')
    const partial = sprintRetroDoc.replace(/\n---\n\n## Sprint Summary[\s\S]*/, '')
    assertNoVisibleNbsp(renderStreamingMarkdown(partial), 'sprint-streaming')
  })

  it('never flashes nbsp while streaming sprint metadata token-by-token', () => {
    const [beforeMetadata = ''] = sprintRetroDoc.split(sprintMetadataLine)
    const prefix = `${beforeMetadata}${sprintMetadataLine.slice(0, 40)}`
    const suffix = sprintMetadataLine.slice(40)
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= suffix.length; i++) {
      renderer.update(prefix + suffix.slice(0, i))
      assert.doesNotMatch(host.textContent, /&nbsp/i, `flash at ${suffix.slice(0, i)}`)
      assert.doesNotMatch(host.innerHTML, /&amp;nbsp/i, `html at ${suffix.slice(0, i)}`)
    }
  })
})

describe('full entity/character reference decoding (#594)', () => {
  it('decodes named, decimal, and hex references in prose', () => {
    const html = renderMarkdown('&copy; &AElig; &#35; &#X22; &frac34;')
    assert.match(html, /© Æ # &quot; ¾/)
  })

  it('decoded punctuation is inert, not markup (spec #39)', () => {
    const html = renderMarkdown('&#42;foo&#42;')
    assert.match(html, /<p>\*foo\*<\/p>/)
    assert.doesNotMatch(html, /<em>/)
  })

  it('keeps dangerous decoded characters HTML-escaped', () => {
    const html = renderMarkdown('&lt;script&gt; &quot;x&quot;')
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('replaces invalid numeric references with U+FFFD (spec #26)', () => {
    assert.match(renderMarkdown('&#0;'), /�/)
  })

  it('does not decode inside code spans (spec #338-ish)', () => {
    assert.match(renderMarkdown('`&amp;`'), /<code>&amp;amp;<\/code>/)
  })

  it('leaves unknown and unterminated references literal (spec #28/#30)', () => {
    const html = renderMarkdown('&nonExistent; &copy no semicolon')
    assert.match(html, /&amp;nonExistent; &amp;copy no semicolon/)
  })

  it('decodes references in link destinations and titles (spec #32)', () => {
    const html = renderMarkdown('[foo](/f&ouml;&ouml; "f&ouml;&ouml;")')
    assert.match(html, /href="\/f%C3%B6%C3%B6"/)
    assert.match(html, /title="föö"/)
  })
})
