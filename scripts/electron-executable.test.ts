import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveElectronExecutable } from '../tests/e2e/helpers/electron-executable.ts'

describe('Electron Node executable export', () => {
  it('preserves executable paths with spaces', () => {
    assert.equal(
      resolveElectronExecutable(() => '/fixture/Electron App'),
      '/fixture/Electron App',
    )
  })
  it('rejects the in-app API and empty exports', () => {
    for (const value of [{ app: {} }, undefined, '', ' ']) {
      assert.throws(() => resolveElectronExecutable(() => value), /executable path/)
    }
  })
})
