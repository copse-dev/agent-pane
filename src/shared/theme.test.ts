import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveThemeFromPreference } from './theme.ts'

describe('resolveThemeFromPreference', () => {
  it('pins light and dark preferences', () => {
    assert.equal(resolveThemeFromPreference('light', true), 'light')
    assert.equal(resolveThemeFromPreference('dark', false), 'dark')
  })

  it('follows the OS when preference is system', () => {
    assert.equal(resolveThemeFromPreference('system', true), 'dark')
    assert.equal(resolveThemeFromPreference('system', false), 'light')
  })
})
