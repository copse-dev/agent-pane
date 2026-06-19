import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  textBlockLabel,
  TEXT_BLOCK_MIN_CHARS,
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
})
