import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyLfViewEdits, fromLfView, toLfView } from './line-endings.ts'

describe('line-endings', () => {
  it('maps every break style to \\n and remembers each one', () => {
    const view = toLfView('a\r\nb\nc\rd')
    assert.equal(view.text, 'a\nb\nc\nd')
    assert.deepEqual(view.breaks, ['\r\n', '\n', '\r'])
    assert.equal(fromLfView(view.text, view.breaks, view.dominant), 'a\r\nb\nc\rd')
  })

  it('picks the dominant break, favouring CRLF on a tie', () => {
    assert.equal(toLfView('a\r\nb\r\nc\n').dominant, '\r\n')
    assert.equal(toLfView('a\r\nb\nc\nd\r\n').dominant, '\r\n')
    assert.equal(toLfView('a\nb\nc\r\n').dominant, '\n')
    assert.equal(toLfView('one line').dominant, '\n')
  })

  it('keeps breaks outside edits and gives new lines the dominant break', () => {
    const view = toLfView('a\r\nb\r\nc\nd\r\n')
    const start = view.text.indexOf('b\nc')
    const edited = applyLfViewEdits(view, [{ start, end: start + 3, replacement: 'B1\nB2\nB3' }])
    // The break after `c` (LF) survives; the one inside the match is dropped;
    // the replacement's two lines break with CRLF.
    assert.equal(edited, 'a\r\nB1\r\nB2\r\nB3\nd\r\n')
  })

  it('applies several edits against the original offsets', () => {
    const view = toLfView('x\r\ny\r\nx\r\n')
    const edited = applyLfViewEdits(view, [
      { start: 0, end: 1, replacement: 'one\ntwo' },
      { start: 4, end: 5, replacement: 'z' },
    ])
    assert.equal(edited, 'one\r\ntwo\r\ny\r\nz\r\n')
  })
})
