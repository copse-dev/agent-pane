import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bootThemeArgument, parseBootThemeArgument, resolveThemeFromPreference } from './theme.ts'

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

describe('boot theme argv', () => {
  it('round-trips the boot theme argument', () => {
    const argv = ['electron', bootThemeArgument('light'), '--other']
    assert.equal(parseBootThemeArgument(argv), 'light')
  })

  it('returns null when the boot theme argument is absent or invalid', () => {
    assert.equal(parseBootThemeArgument(['electron']), null)
    assert.equal(parseBootThemeArgument([bootThemeArgument('sepia' as 'light')]), null)
  })
})
