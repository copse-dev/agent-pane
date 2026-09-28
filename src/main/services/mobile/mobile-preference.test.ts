import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobilePreference } from './mobile-preference.ts'

describe('mobile enablement', () => {
  it('remembers the enabled choice across instances and only turns off explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-mobile-preference-'))
    try {
      const preference = new MobilePreference(dir)
      assert.equal(preference.current().enabled, false)
      preference.enable('192.168.1.41')
      assert.deepEqual(new MobilePreference(dir).current(), {
        enabled: true,
        address: '192.168.1.41',
      })
      assert.equal(statSync(join(dir, 'service.json')).mode & 0o777, 0o600)
      preference.disable()
      assert.equal(new MobilePreference(dir).current().enabled, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
