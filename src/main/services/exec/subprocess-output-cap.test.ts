import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
  stripTerminalControlSequences,
  truncateCommandOutput,
} from './subprocess-output-cap.ts'

describe('stripTerminalControlSequences', () => {
  it('removes SGR and clears screen sequences', () => {
    assert.equal(stripTerminalControlSequences('\x1b[31mred\x1b[0m'), 'red')
    assert.equal(stripTerminalControlSequences('ok\x1b[2Jmore'), 'okmore')
  })

  it('preserves literal bracket text without ESC', () => {
    assert.equal(stripTerminalControlSequences('[not-ansi]'), '[not-ansi]')
  })
})

describe('truncateCommandOutput', () => {
  it('returns input when under the cap', () => {
    assert.equal(truncateCommandOutput('hello', 100), 'hello')
  })

  it('keeps head and tail with a marker', () => {
    const out = truncateCommandOutput('a'.repeat(100), 40)
    assert.ok(out.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.ok(out.startsWith('aaa'))
    assert.ok(out.endsWith('aaa'))
  })
})

describe('CappedOutputAccumulator', () => {
  it('streams and stores within the cap without dropping when small', () => {
    const acc = new CappedOutputAccumulator(200)
    assert.equal(acc.append('hello '), 'hello ')
    assert.equal(acc.append('world'), 'world')
    assert.equal(acc.toString(), 'hello world')
  })

  it('emits a truncation marker once output exceeds the cap', () => {
    const acc = new CappedOutputAccumulator(40)
    acc.append('a'.repeat(30))
    acc.append('b'.repeat(30))
    assert.ok(acc.toString().includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
  })
})
