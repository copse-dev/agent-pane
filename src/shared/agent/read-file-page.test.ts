import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReadFilePageMeta, formatReadFilePageFooter } from './read-file-page.ts'

describe('read-file-page', () => {
  it('includes continuation hint and JSON meta when truncated', () => {
    const meta = buildReadFilePageMeta('src/a.ts', 500, 1, 150, true)
    const footer = formatReadFilePageFooter(meta, false)
    assert.match(footer, /start_line=151/)
    assert.match(footer, /read_file_page/)
    assert.match(footer, /"nextStartLine":151/)
  })

  it('omits footer when nothing was truncated', () => {
    const meta = buildReadFilePageMeta('x', 10, 1, 10, false)
    assert.equal(formatReadFilePageFooter(meta, false), '')
  })
})
