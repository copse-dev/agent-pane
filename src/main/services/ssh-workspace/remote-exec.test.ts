import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRemoteArgvCommand, buildRemoteShellCommand } from './remote-exec.ts'

describe('remote exec quoting', () => {
  it('quotes argv segments and cwd', () => {
    const cmd = buildRemoteArgvCommand(['echo', 'hello world'], '/tmp/my dir', undefined)
    assert.match(cmd, /cd '\/tmp\/my dir'/)
    assert.match(cmd, /'echo' 'hello world'/)
  })

  it('prefixes env assignments', () => {
    const cmd = buildRemoteShellCommand('npm test', '/repo', { NODE_ENV: 'test' })
    assert.match(cmd, /env NODE_ENV='test'/)
    assert.match(cmd, /cd '\/repo'/)
    assert.match(cmd, /npm test/)
  })

  it('preserves quotes in filenames', () => {
    const cmd = buildRemoteArgvCommand(["it's"], undefined, undefined)
    assert.equal(cmd, `'it'\\''s'`)
  })

  it('rejects env keys that are not valid shell identifiers', () => {
    const cmd = buildRemoteShellCommand('npm test', undefined, {
      NODE_ENV: 'test',
      'LD_PRELOAD=evil': 'ignored',
      'FOO=bar': 'also ignored',
    })
    assert.match(cmd, /env NODE_ENV='test'/)
    assert.doesNotMatch(cmd, /LD_PRELOAD/)
    assert.doesNotMatch(cmd, /FOO=bar/)
  })
})
