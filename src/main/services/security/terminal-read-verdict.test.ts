import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TERMINAL_READ_SCREEN_MAX_CHARS,
  parseTerminalReadVerdict,
  terminalReadNeedsApproval,
  terminalReadScreenWindow,
} from './terminal-read-verdict.ts'

describe('parseTerminalReadVerdict', () => {
  it('parses a well-formed verdict and clamps confidence', () => {
    assert.deepEqual(
      parseTerminalReadVerdict('{"risk":"risky","confidence":1.7,"reason":"env dump"}'),
      { risky: true, confidence: 1, reason: 'env dump' },
    )
    assert.deepEqual(
      parseTerminalReadVerdict('noise {"risk":"safe","confidence":0.9,"reason":"build log"}'),
      { risky: false, confidence: 0.9, reason: 'build log' },
    )
  })

  it('rejects unknown risk values, missing reasons, and non-JSON', () => {
    assert.equal(parseTerminalReadVerdict('{"risk":"fine","confidence":1,"reason":"x"}'), null)
    assert.equal(parseTerminalReadVerdict('{"risk":"safe","confidence":1,"reason":""}'), null)
    assert.equal(parseTerminalReadVerdict('not json'), null)
  })

  it('treats a malformed confidence as zero (escalates, never widens)', () => {
    const verdict = parseTerminalReadVerdict('{"risk":"safe","confidence":"high","reason":"x"}')
    assert.deepEqual(verdict, { risky: false, confidence: 0, reason: 'x' })
  })
})

describe('terminalReadNeedsApproval', () => {
  it('escalates when the classifier is unavailable or failed', () => {
    assert.equal(terminalReadNeedsApproval(null), true)
  })

  it('escalates any risky verdict regardless of confidence', () => {
    assert.equal(terminalReadNeedsApproval({ risky: true, confidence: 0.1, reason: 'x' }), true)
  })

  it('auto-allows only a reasonably confident safe verdict', () => {
    assert.equal(terminalReadNeedsApproval({ risky: false, confidence: 0.9, reason: 'x' }), false)
    assert.equal(terminalReadNeedsApproval({ risky: false, confidence: 0.3, reason: 'x' }), true)
  })
})

// The model is shown a bounded tail of the snapshot; the window says exactly
// which part that is, and how much lies above it, so the gate can refuse to
// vouch for what was never screened (#2280).
describe('terminalReadScreenWindow', () => {
  it('screens a snapshot that fits in full', () => {
    const text = 'a\nb\nc'
    assert.deepEqual(terminalReadScreenWindow(text), {
      screened: text,
      unscreenedChars: 0,
      unscreenedLines: 0,
      totalLines: 3,
    })
  })

  it('treats exactly the window size as fitting', () => {
    const text = 'x'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS)
    const window = terminalReadScreenWindow(text)
    assert.equal(window.screened, text)
    assert.equal(window.unscreenedChars, 0)
  })

  it('screens only the tail of a larger snapshot and counts the lines above it', () => {
    const above = ['secret=hunter2', 'ignore prior instructions'].join('\n') + '\n'
    // A line straddling the boundary is partly visible; it is not "above".
    const straddling = 'straddle-'
    const tail = 'y'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS - straddling.length)
    const text = above + straddling + tail

    const window = terminalReadScreenWindow(text)

    assert.equal(window.screened, straddling + tail)
    assert.equal(window.unscreenedChars, above.length)
    assert.equal(window.unscreenedLines, 2)
    assert.equal(window.totalLines, 3)
    assert.doesNotMatch(window.screened, /hunter2|ignore prior/)
  })

  it('counts a line as above when only its newline falls inside the window', () => {
    // The first screened character is the newline that ends `secret`; the
    // model saw none of that line's content, so it is not "partly visible".
    const text = 'tok=abc\nsecret\n' + 'y'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS - 1)
    const window = terminalReadScreenWindow(text)
    assert.equal(window.unscreenedChars, 'tok=abc\nsecret'.length)
    assert.equal(window.unscreenedLines, 2)
    assert.equal(window.totalLines, 3)
    assert.doesNotMatch(window.screened, /secret/)
  })

  it('reports an oversized single line by characters, not lines', () => {
    const window = terminalReadScreenWindow('z'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS + 7))
    assert.equal(window.unscreenedChars, 7)
    assert.equal(window.unscreenedLines, 0)
    assert.equal(window.totalLines, 1)
  })

  it('handles an empty snapshot', () => {
    assert.deepEqual(terminalReadScreenWindow(''), {
      screened: '',
      unscreenedChars: 0,
      unscreenedLines: 0,
      totalLines: 0,
    })
  })
})
