import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  textBlockLabel,
  truncateAttachmentContent,
  TEXT_BLOCK_MIN_CHARS,
  ATTACHMENT_MAX_CHARS,
} from './build-text-with-attachments.ts'

describe('isTextBlockAttachment', () => {
  it('rejects empty or whitespace-only text', () => {
    assert.equal(isTextBlockAttachment(''), false)
    assert.equal(isTextBlockAttachment('   \n  '), false)
  })

  it('accepts multiline text regardless of length', () => {
    assert.equal(isTextBlockAttachment('line one\nline two'), true)
  })

  it(`accepts long single-line text (>= ${TEXT_BLOCK_MIN_CHARS} chars)`, () => {
    assert.equal(isTextBlockAttachment('a'.repeat(TEXT_BLOCK_MIN_CHARS)), true)
  })

  it('rejects short single-line text', () => {
    assert.equal(isTextBlockAttachment('short prompt'), false)
  })
})

describe('textBlockLabel', () => {
  it('uses the first line as the label', () => {
    assert.equal(textBlockLabel('function foo() {\n  return 1\n}'), 'function foo() {')
  })

  it('truncates long first lines', () => {
    const long = 'x'.repeat(60)
    assert.equal(textBlockLabel(long), `${'x'.repeat(45)}…`)
  })
})

describe('buildTextWithAttachments', () => {
  it('inlines file and text-block attachments into fenced code blocks', () => {
    const result = buildTextWithAttachments(
      'Please review',
      [{ path: 'src/a.ts', content: 'export const a = 1' }],
      [{ label: 'Error log', content: 'TypeError: x is not defined' }],
    )
    assert.match(result, /^Please review/)
    assert.match(result, /```\n\/\/ src\/a\.ts\nexport const a = 1\n```/)
    assert.match(result, /```\n\/\/ Error log\nTypeError: x is not defined\n```/)
  })

  it('caps oversized attachment content so a single paste cannot overflow context', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    assert.ok(huge.length > ATTACHMENT_MAX_CHARS)
    const result = buildTextWithAttachments('review', [{ path: 'big.log', content: huge }])
    assert.ok(result.length < huge.length)
    assert.match(result, /Copse trimmed/)
    // Head and tail are preserved for context at both ends.
    assert.match(result, /line 0\b/)
    assert.match(result, /line 4999\b/)
  })
})

describe('truncateAttachmentContent', () => {
  it('returns content unchanged when it fits the cap', () => {
    const small = 'hello\nworld'
    assert.equal(truncateAttachmentContent(small, 100), small)
    assert.equal(truncateAttachmentContent('a'.repeat(100), 100), 'a'.repeat(100))
  })

  it('keeps head and tail and records what was dropped when over the cap', () => {
    const content = Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n')
    const out = truncateAttachmentContent(content, 400)
    assert.ok(out.length <= content.length)
    assert.match(out, /^row 0\b/)
    assert.match(out, /row 199$/)
    assert.match(out, /Copse trimmed \d[\d,]* characters \(~\d[\d,]* lines\)/)
  })

  it('cuts on line boundaries (no split partial lines around the marker)', () => {
    const content = Array.from({ length: 100 }, (_, i) => `value-${i}`).join('\n')
    const out = truncateAttachmentContent(content, 300)
    const [beforeMarker, afterMarker] = out.split(/\n\n… \[Copse trimmed[^\n]*\] …\n\n/)
    assert.ok(beforeMarker && afterMarker)
    // Every retained line is a complete `value-N` token, never a fragment.
    for (const line of `${beforeMarker}\n${afterMarker}`.split('\n')) {
      if (line) assert.match(line, /^value-\d+$/)
    }
  })
})
