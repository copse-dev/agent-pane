import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTrustedCommands,
  isValidTrustedCommand,
  parseTrustedCommands,
  sanitizeTrustedCommands,
} from './command-routing.ts'

describe('parseTrustedCommands', () => {
  it('parses one command per line, skipping comments/blanks', () => {
    assert.deepEqual(parseTrustedCommands('# tools\n\nxcodebuild\npod\n'), ['xcodebuild', 'pod'])
  })

  it('accepts a legacy `command:tier` line by keeping the bare name', () => {
    assert.deepEqual(parseTrustedCommands('xcodebuild:allow'), ['xcodebuild'])
  })

  it('drops invalid names and duplicates', () => {
    assert.deepEqual(parseTrustedCommands('xcodebuild\n/usr/bin/x\nrm -rf\nxcodebuild'), [
      'xcodebuild',
    ])
  })

  it('round-trips through formatTrustedCommands', () => {
    const text = 'xcodebuild\npod'
    assert.equal(formatTrustedCommands(parseTrustedCommands(text)), text)
  })
})

describe('isValidTrustedCommand', () => {
  it('accepts bare basenames and rejects paths/args/metacharacters', () => {
    assert.ok(isValidTrustedCommand('xcodebuild'))
    assert.ok(isValidTrustedCommand('swift-format'))
    assert.ok(!isValidTrustedCommand('/usr/bin/x'))
    assert.ok(!isValidTrustedCommand('rm -rf'))
    assert.ok(!isValidTrustedCommand('a;b'))
  })
})

describe('sanitizeTrustedCommands', () => {
  it('drops non-array, non-string, and malformed entries', () => {
    assert.deepEqual(sanitizeTrustedCommands(null), [])
    assert.deepEqual(sanitizeTrustedCommands(['xcodebuild', '', 'a b', 'xcodebuild', 42, 'pod']), [
      'xcodebuild',
      'pod',
    ])
  })
})
