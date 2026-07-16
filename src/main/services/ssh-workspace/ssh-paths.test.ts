import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CONTROL_SOCKET_PATH_BUDGET,
  controlSocketFileName,
  controlSocketPath,
  setSshControlDirForTests,
  UNIX_DOMAIN_SOCKET_PATH_MAX,
} from './ssh-paths.ts'

describe('controlSocketPath', () => {
  afterEach(() => {
    setSshControlDirForTests(null)
  })

  it('uses a short hashed filename so long host ids stay under the Unix socket budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-cm-'))
    try {
      setSshControlDirForTests(dir)
      const hostId = 'euw-serp-dev-testing16'
      const path = controlSocketPath(hostId)
      assert.equal(controlSocketFileName(hostId).length, '0123456789abcdef.sock'.length)
      assert.ok(
        Buffer.byteLength(path, 'utf8') <= CONTROL_SOCKET_PATH_BUDGET,
        `path length ${String(Buffer.byteLength(path, 'utf8'))} exceeds budget ${String(CONTROL_SOCKET_PATH_BUDGET)}: ${path}`,
      )
      // Even with OpenSSH's bind-time suffix, stay within sun_path.
      const withSuffix = `${path}.fUyzwh1gIvt57SO8`
      assert.ok(
        Buffer.byteLength(withSuffix, 'utf8') <= UNIX_DOMAIN_SOCKET_PATH_MAX,
        `path+suffix length ${String(Buffer.byteLength(withSuffix, 'utf8'))} exceeds ${String(UNIX_DOMAIN_SOCKET_PATH_MAX)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays under budget for the macOS Application Support path that used to break', () => {
    // Simulate the old layout length; the new helper must not place sockets there.
    const legacy = `/Users/jonathankingston/Library/Application Support/copse-panel/ssh/euw-serp-dev-testing16.sock`
    assert.ok(Buffer.byteLength(legacy, 'utf8') > CONTROL_SOCKET_PATH_BUDGET)

    const path = controlSocketPath('euw-serp-dev-testing16')
    assert.doesNotMatch(path, /Application Support/)
    assert.ok(Buffer.byteLength(path, 'utf8') <= CONTROL_SOCKET_PATH_BUDGET)
    assert.ok(Buffer.byteLength(`${path}.fUyzwh1gIvt57SO8`, 'utf8') <= UNIX_DOMAIN_SOCKET_PATH_MAX)
  })
})
