import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mobileDeviceAccessArgsSchema, mobilePairingArgsSchema } from './mobile-companion-args.ts'

const deviceId = '8abde2d0-8c97-4a99-9ea8-a7518309ee52'

it('requires explicit desktop trust acknowledgement for pairing and device control', () => {
  for (const acknowledgement of [undefined, false, 'true', 1, null]) {
    assert.equal(
      mobilePairingArgsSchema.safeParse(['control', '123456', acknowledgement]).success,
      false,
    )
    assert.equal(
      mobileDeviceAccessArgsSchema.safeParse([deviceId, 'control', acknowledgement]).success,
      false,
    )
  }
  assert.equal(mobilePairingArgsSchema.safeParse(['control', '123456', true]).success, true)
  assert.equal(mobileDeviceAccessArgsSchema.safeParse([deviceId, 'control', true]).success, true)
})

it('allows read-only, denial, and downgrade without certificate acknowledgement', () => {
  for (const decision of ['read', 'deny']) {
    assert.equal(mobilePairingArgsSchema.safeParse([decision, '123456']).success, true)
  }
  assert.equal(mobileDeviceAccessArgsSchema.safeParse([deviceId, 'read']).success, true)
})

it('rejects missing pairing identity, malformed codes, invalid devices and unknown decisions', () => {
  for (const code of [undefined, '', '12345', '1234567', 'abcdef']) {
    assert.equal(mobilePairingArgsSchema.safeParse(['control', code, true]).success, false)
  }
  assert.equal(mobilePairingArgsSchema.safeParse(['approve', '123456', true]).success, false)
  assert.equal(mobileDeviceAccessArgsSchema.safeParse(['unknown', 'control', true]).success, false)
})
