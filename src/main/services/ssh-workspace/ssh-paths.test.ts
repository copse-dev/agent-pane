import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { shortSocketDirectory } from '../../../../tests/helpers/short-socket-directory.ts'
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

  it('uses a short hashed filename so long host ids stay under the Unix socket budget', (t) => {
    // This test is about the filename budget. macOS TMPDIR normally lives
    // under /var/folders and can itself exceed the entire stable socket-path
    // budget; production deliberately uses /tmp for that reason.
    const dir = shortSocketDirectory(t)
    setSshControlDirForTests(dir)
    const hostId = 'remote-dev-testing-016'
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
  })

  it('stays under budget for the macOS Application Support path that used to break', (t) => {
    // Simulate the old layout length; the new helper must not place sockets there.
    const legacy = `/Users/alexandra-morgan/Library/Application Support/copse-panel/ssh/remote-dev-testing-016.sock`
    assert.ok(Buffer.byteLength(legacy, 'utf8') > CONTROL_SOCKET_PATH_BUDGET)

    // Verify the production default path without creating its shared directory.
    const mkdir = t.mock.method(fs, 'mkdirSync', () => undefined)
    syncBuiltinESMExports()
    try {
      const path = controlSocketPath('remote-dev-testing-016')
      assert.equal(mkdir.mock.callCount(), 1)
      assert.doesNotMatch(path, /Application Support/)
      assert.ok(Buffer.byteLength(path, 'utf8') <= CONTROL_SOCKET_PATH_BUDGET)
      assert.ok(
        Buffer.byteLength(`${path}.fUyzwh1gIvt57SO8`, 'utf8') <= UNIX_DOMAIN_SOCKET_PATH_MAX,
      )
    } finally {
      mkdir.mock.restore()
      syncBuiltinESMExports()
    }
  })
})
