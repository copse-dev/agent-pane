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

  it('returns undefined for keys without a registered schema', () => {
    assert.equal(getSettingSchema('someUnknownKey'), undefined)
  })
})
