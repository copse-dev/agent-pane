import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileDevices } from './mobile-devices.ts'

describe('mobile paired devices', () => {
  it('persists only a token hash and revokes access immediately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-mobile-devices-'))
    try {
      const devices = new MobileDevices(dir)
      const issued = devices.issue('Test phone')
      const file = join(dir, 'devices.json')
      assert.equal(readFileSync(file, 'utf8').includes(issued.token), false)
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(devices.authenticate(`Bearer ${issued.token}`), true)
      assert.equal(new MobileDevices(dir).authenticate(`Bearer ${issued.token}`), true)
      devices.revoke(issued.id)
      assert.equal(devices.authenticate(`Bearer ${issued.token}`), false)
      assert.equal(new MobileDevices(dir).authenticate(`Bearer ${issued.token}`), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
