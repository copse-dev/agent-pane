import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  APP_ICON_VARIANT_SCHEMES,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
} from './app-icon-variants.ts'

describe('app-icon-variants', () => {
  it('lists the 15 Icon Studio colour schemes', () => {
    assert.deepEqual(
      [...APP_ICON_VARIANTS],
      [
        'aurora',
        'citrus',
        'candy',
        'steel',
        'amber',
        'forest',
        'orchid',
        'sunset',
        'ocean',
        'emerald',
        'nebula',
        'ember',
        'paper',
        'coral',
        'lagoon',
      ],
    )
  })

  it('defaults to aurora', () => {
    assert.equal(DEFAULT_APP_ICON_VARIANT, 'aurora')
  })

  it('has a label and a colour scheme for every variant', () => {
    for (const variant of APP_ICON_VARIANTS) {
      assert.equal(typeof APP_ICON_VARIANT_LABELS[variant], 'string')
      const scheme = APP_ICON_VARIANT_SCHEMES[variant]
      for (const channel of [scheme.start, scheme.end, scheme.bg]) {
        assert.match(channel, /^#[0-9A-Fa-f]{6}$/)
      }
    }
  })

  it('validates known variants', () => {
    assert.equal(isAppIconVariant('aurora'), true)
    assert.equal(isAppIconVariant('lagoon'), true)
    assert.equal(isAppIconVariant('wave'), false)
    assert.equal(isAppIconVariant('other'), false)
    assert.equal(isAppIconVariant(null), false)
  })
})
