import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  it('migrates old pairings as read-only, persists explicit control, and immediately downgrades', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-mobile-access-'))
    try {
      const devices = new MobileDevices(dir)
      const issued = devices.issue('My phone')
      const header = `Bearer ${issued.token}`
      assert.deepEqual(devices.principal(header), {
        id: issued.id,
        label: 'My phone',
        access: 'read',
      })
      const file = join(dir, 'devices.json')
      writeFileSync(file, readFileSync(file, 'utf8').replace(/,\n\s+"access": "read"/, ''))
      assert.equal(new MobileDevices(dir).principal(header)?.access, 'read')
      devices.setAccess(issued.id, 'control')
      assert.equal(new MobileDevices(dir).principal(header)?.access, 'control')
      devices.setAccess(issued.id, 'read')
      assert.equal(devices.principal(header)?.access, 'read')
      devices.revoke(issued.id)
      assert.equal(devices.principal(header), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
