import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
  migrateLegacyAppearanceDefaults,
} from './appearance.ts'

describe('legacy Appearance defaults migration', () => {
  it('migrates the exact legacy default tuple to the current defaults', () => {
    assert.deepEqual(
      migrateLegacyAppearanceDefaults({
        theme: 'system',
        uiAccentColor: '#20fd85',
        uiTintColor: '#002e2b',
        uiTintStrength: 'subtle',
      }),
      {
        theme: 'dark',
        uiAccentColor: DEFAULT_ACCENT_COLOR,
        uiTintColor: DEFAULT_TINT_COLOR,
        uiTintStrength: DEFAULT_TINT_STRENGTH,
      },
    )
  })

  it('preserves partial and user-customised combinations', () => {
    const legacy = {
      theme: 'system',
      uiAccentColor: '#20FD85',
      uiTintColor: '#002E2B',
      uiTintStrength: 'subtle',
    }

    assert.equal(migrateLegacyAppearanceDefaults({ ...legacy, theme: 'light' }), null)
    assert.equal(migrateLegacyAppearanceDefaults({ ...legacy, uiAccentColor: '#20FD84' }), null)
    assert.equal(migrateLegacyAppearanceDefaults({ ...legacy, uiTintColor: '#244C25' }), null)
    assert.equal(migrateLegacyAppearanceDefaults({ ...legacy, uiTintStrength: 'strong' }), null)
  })
})
