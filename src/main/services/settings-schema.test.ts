import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSettingSchema } from './settings-schema.ts'

describe('settings-schema', () => {
  it('returns a schema for known renderer-writable keys', () => {
    const schema = getSettingSchema('theme')
    assert.ok(schema)
    assert.equal(schema.safeParse('dark').success, true)
    assert.equal(schema.safeParse('neon').success, false)
  })

  it('returns a schema for known main-only keys', () => {
    const bounds = getSettingSchema('windowBounds')
    assert.ok(bounds)
    assert.equal(bounds.safeParse({ width: 100, height: 100 }).success, true)
    assert.equal(bounds.safeParse({ width: -1, height: 100 }).success, false)
    assert.equal(bounds.safeParse('garbage').success, false)
  })

  it('validates numeric/range settings', () => {
    const fontSize = getSettingSchema('fontSize')
    assert.ok(fontSize)
    assert.equal(fontSize.safeParse(14).success, true)
    assert.equal(fontSize.safeParse(999).success, false)
    assert.equal(fontSize.safeParse('14').success, false)
  })

  it('validates portrait layout toggle settings', () => {
    const autoPortraitRightPanel = getSettingSchema('autoPortraitRightPanel')
    assert.ok(autoPortraitRightPanel)
    assert.equal(autoPortraitRightPanel.safeParse(true).success, true)
    assert.equal(autoPortraitRightPanel.safeParse('true').success, false)
  })

  it('validates the right panel position setting', () => {
    const rightPanelPosition = getSettingSchema('rightPanelPosition')
    assert.ok(rightPanelPosition)
    assert.equal(rightPanelPosition.safeParse('auto').success, true)
    assert.equal(rightPanelPosition.safeParse('side').success, true)
    assert.equal(rightPanelPosition.safeParse('bottom').success, true)
    assert.equal(rightPanelPosition.safeParse('top').success, false)
  })

  it('returns undefined for keys without a registered schema', () => {
    assert.equal(getSettingSchema('someUnknownKey'), undefined)
  })

  it('rejects extra-provider base URLs that could leak the API key', () => {
    const schema = getSettingSchema('extraProviders')
    assert.ok(schema)
    const custom = (baseUrl: string): unknown => [{ slug: 'custom', baseUrl }]
    // Safe: https to a public host, http only for loopback, or absent (use preset default).
    assert.equal(schema.safeParse(custom('https://api.together.xyz/v1')).success, true)
    assert.equal(schema.safeParse(custom('http://localhost:1234/v1')).success, true)
    assert.equal(schema.safeParse([{ slug: 'custom' }]).success, true)
    // Unsafe: cleartext http to a non-loopback host, https to a private/link-local
    // address, and embedded credentials.
    assert.equal(schema.safeParse(custom('http://attacker.example/v1')).success, false)
    assert.equal(schema.safeParse(custom('http://169.254.169.254/latest')).success, false)
    assert.equal(schema.safeParse(custom('https://169.254.169.254/latest')).success, false)
    assert.equal(schema.safeParse(custom('https://192.168.1.5/v1')).success, false)
    assert.equal(schema.safeParse(custom('https://user:pass@evil.example/v1')).success, false)
    assert.equal(schema.safeParse(custom('not a url')).success, false)
  })
})
