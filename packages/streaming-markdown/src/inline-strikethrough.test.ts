import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStrikethrough, strikethroughHoldStart } from './inline-strikethrough.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderMarkdown } from './renderer.ts'
import { scanCodeSpans } from './inline-code-spans.ts'

describe('renderStrikethrough (GFM ~~)', () => {
  it('wraps a paired double-tilde span in <del>', () => {
    assert.equal(renderStrikethrough('~~gone~~'), '<del>gone</del>')
    assert.equal(renderStrikethrough('keep ~~drop~~ keep'), 'keep <del>drop</del> keep')
  })

  it('leaves a lone tilde untouched (date/number ranges)', () => {
    assert.equal(renderStrikethrough('20~25'), '20~25')
    assert.equal(renderStrikethrough('a ~ b'), 'a ~ b')
  })

  it('ignores runs of one or three-plus tildes', () => {
    assert.equal(renderStrikethrough('~single~'), '~single~')
    assert.equal(renderStrikethrough('~~~triple~~~'), '~~~triple~~~')
  })

  it('leaves an unpaired ~~ literal', () => {
    assert.equal(renderStrikethrough('half ~~open'), 'half ~~open')
  })

  it('does not pair ~~ inside a rendered code span', () => {
    assert.equal(renderStrikethrough('a <code>x~~y~~z</code> b'), 'a <code>x~~y~~z</code> b')
  })

  it('handles two independent spans on one line', () => {
    assert.equal(renderStrikethrough('~~a~~ and ~~b~~'), '<del>a</del> and <del>b</del>')
  })
})

describe('strikethrough in the inline pipeline', () => {
  it('nests emphasis inside strikethrough', () => {
    assert.equal(renderInlineSpans('~~*x*~~'), '<del><em>x</em></del>')
    assert.equal(renderInlineSpans('**~~x~~**'), '<strong><del>x</del></strong>')
  })

  it('resolves a link inside a struck span', () => {
    const html = renderInlineSpans('~~[label](https://example.com)~~')
    assert.match(html, /^<del><a href="https:\/\/example\.com"/)
    assert.match(html, />label<\/a><\/del>$/)
  })

  it('renders through the full block renderer', () => {
    assert.equal(renderMarkdown('~~removed~~'), '<p><del>removed</del></p>')
  })

  it('keeps ~~ inside a fenced code block literal', () => {
    const html = renderMarkdown('```\n~~notdel~~\n```')
    assert.match(html, /~~notdel~~/)
    assert.doesNotMatch(html, /<del>/)
  })
})

describe('strikethrough streaming hold', () => {
  const visible = (s: string): string => s.slice(0, pendingHoldIndex(s))
  const holdStart = (s: string): number => strikethroughHoldStart(s, scanCodeSpans(s).mask)

  it('holds a half-open ~~ span mid-stream', () => {
    assert.equal(visible('intro ~~struck'), 'intro ')
  })

  it('reveals a completed ~~ span', () => {
    assert.equal(pendingHoldIndex('all ~~done~~ here'), 'all ~~done~~ here'.length)
    assert.equal(pendingHoldIndex('~~done~~'), '~~done~~'.length)
  })

  it('holds a lone trailing ~ that could open a span', () => {
    assert.equal(holdStart('text ~'), 'text '.length)
  })

  it('does not hold a lone tilde in the middle of settled text', () => {
    assert.equal(pendingHoldIndex('range 20~25 ok'), 'range 20~25 ok'.length)
  })
})
