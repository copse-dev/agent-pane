import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { localSocketPath } from './local-socket.ts'

describe('localSocketPath', () => {
  it('keeps a socket in the profile when the path is short enough', () => {
    assert.equal(dirname(localSocketPath('/p', 'turn-host', 'host', 'linux')), join('/p', 'run'))
  })

  it("puts a long profile's socket in a directory only this user can reach", () => {
    const path = localSocketPath(`/${'x'.repeat(120)}`, 'turn-host', 'host', 'linux')
    const dir = dirname(path)
    assert.equal(dirname(dir), tmpdir())
    const stat = statSync(dir)
    assert.equal(stat.mode & 0o077, 0)
    assert.equal(stat.uid, process.getuid?.() ?? 0)
  })
})
