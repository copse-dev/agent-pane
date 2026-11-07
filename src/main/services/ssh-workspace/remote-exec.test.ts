import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRemoteArgvCommand,
  buildRemotePtyCommand,
  buildRemoteShellCommand,
} from './remote-exec.ts'

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

describe('buildRemoteShellCommand with an exec line', () => {
  it('passes the env as shell assignments, since env cannot run the exec builtin', () => {
    const cmd = buildRemoteShellCommand('exec "$HOME/.copse/bin/watcher"', '/repo', {
      LANG: 'en_GB.UTF-8',
      TERM: 'xterm-256color',
    })
    assert.equal(cmd.includes('env '), false)
    assert.match(
      cmd,
      /^cd '\/repo' && LANG='en_GB\.UTF-8' TERM='xterm-256color' exec "\$HOME\/\.copse\/bin\/watcher"$/,
    )
  })

  it('keeps the env prefix for a line that does not exec', () => {
    assert.match(
      buildRemoteShellCommand('npm test', undefined, { LANG: 'C' }),
      /^env LANG='C' npm test$/,
    )
  })
})

describe('buildRemotePtyCommand', () => {
  it('uses shell assignments before builtin exec, never env … exec', () => {
    const cmd = buildRemotePtyCommand('/bin/bash', '/srv/app', {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
    })
    assert.equal(
      cmd,
      "cd '/srv/app' && TERM='xterm-256color' COLORTERM='truecolor' LANG='C.UTF-8' exec '/bin/bash' -l",
    )
    assert.doesNotMatch(cmd, /\benv\b/)
  })
})
