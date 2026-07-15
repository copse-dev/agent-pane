import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { takeLastLines, READ_TERMINAL_MAX_LINES } from './read-terminal.ts'

describe('takeLastLines', () => {
  it('returns the full text when under the limit', () => {
    assert.equal(takeLastLines('a\nb\nc', 10), 'a\nb\nc')
  })

  it('keeps only the last N lines', () => {
    assert.equal(takeLastLines('a\nb\nc\nd', 2), 'c\nd')
  })

  it('normalizes CR and returns empty for blank input', () => {
    assert.equal(takeLastLines('a\r\nb\rc', 10), 'a\nb\nc')
    assert.equal(takeLastLines('  \n  ', 10), '')
  })

  it('clamps to the hard max', () => {
    const lines = Array.from({ length: READ_TERMINAL_MAX_LINES + 50 }, (_, i) => String(i))
    const out = takeLastLines(lines.join('\n'), READ_TERMINAL_MAX_LINES + 100)
    assert.equal(out.split('\n').length, READ_TERMINAL_MAX_LINES)
    assert.equal(out.split('\n')[0], '50')
  })
})
