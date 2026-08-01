import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  canRunTerminalCommand,
  requestTerminalCommand,
  setTerminalCommandLauncher,
} from './terminal-launch.ts'

describe('terminal-launch', () => {
  afterEach(() => {
    setTerminalCommandLauncher(null)
  })

  it('forwards the trimmed command to the registered launcher', () => {
    const seen: string[] = []
    setTerminalCommandLauncher((command) => seen.push(command))
    assert.equal(requestTerminalCommand('  claude /login  '), true)
    assert.deepEqual(seen, ['claude /login'])
  })

  it('reports that nothing ran with no launcher attached', () => {
    assert.equal(canRunTerminalCommand(), false)
    assert.equal(requestTerminalCommand('claude /login'), false)
  })

  it('never opens a shell for a blank command', () => {
    const seen: string[] = []
    setTerminalCommandLauncher((command) => seen.push(command))
    assert.equal(requestTerminalCommand('   '), false)
    assert.deepEqual(seen, [])
  })
})
