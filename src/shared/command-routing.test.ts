import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCommandRoutes,
  parseCommandRoutes,
  sanitizeCommandRoutes,
} from './command-routing.ts'

describe('parseCommandRoutes', () => {
  it('parses `command:tier` lines and skips comments/blanks', () => {
    const routes = parseCommandRoutes('# comment\n\nxcodebuild:allow\nls:read\n')
    assert.deepEqual(routes, [
      { command: 'xcodebuild', tier: 'allow' },
      { command: 'ls', tier: 'read' },
    ])
  })

  it('drops unknown tiers and malformed lines', () => {
    const routes = parseCommandRoutes('foo:bogus\nno-colon\nbar:write')
    assert.deepEqual(routes, [{ command: 'bar', tier: 'write' }])
  })

  it('keeps the first rule on duplicate commands', () => {
    const routes = parseCommandRoutes('git:read\ngit:allow')
    assert.deepEqual(routes, [{ command: 'git', tier: 'read' }])
  })

  it('round-trips through formatCommandRoutes', () => {
    const text = 'xcodebuild:allow\nmkdir:write'
    assert.equal(formatCommandRoutes(parseCommandRoutes(text)), text)
  })
})

describe('sanitizeCommandRoutes', () => {
  it('drops non-array and malformed entries', () => {
    assert.deepEqual(sanitizeCommandRoutes(null), [])
    assert.deepEqual(
      sanitizeCommandRoutes([
        { command: 'ls', tier: 'read' },
        { command: '', tier: 'read' },
        { command: 'x', tier: 'nope' },
        { command: 'ls', tier: 'write' }, // duplicate
        'garbage',
      ]),
      [{ command: 'ls', tier: 'read' }],
    )
  })
})
