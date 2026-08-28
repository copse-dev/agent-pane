import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_APP_BYTES,
  MAX_INSTALLER_BYTES,
  assertReleaseSizes,
} from './check-macos-release-size.mts'

describe('macOS release size budgets', () => {
  it('accepts a lean package at the boundary', () => {
    assert.doesNotThrow(() => {
      assertReleaseSizes([
        { name: 'Copse-arm64.dmg', bytes: MAX_INSTALLER_BYTES, limit: MAX_INSTALLER_BYTES },
        { name: 'Copse.app', bytes: MAX_APP_BYTES, limit: MAX_APP_BYTES },
      ])
    })
  })

  it('rejects an installer regression with an actionable measurement', () => {
    assert.throws(() => {
      assertReleaseSizes([
        {
          name: 'Copse-x64.zip',
          bytes: MAX_INSTALLER_BYTES + 1024 * 1024,
          limit: MAX_INSTALLER_BYTES,
        },
      ])
    }, /Copse-x64\.zip 231\.0 MiB > 230\.0 MiB/)
  })
})
