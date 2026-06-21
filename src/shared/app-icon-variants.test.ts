import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_ICON_VARIANTS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
} from './app-icon-variants.ts'

describe('app-icon-variants', () => {
  it('includes classic and wave', () => {
    assert.deepEqual([...APP_ICON_VARIANTS], ['classic', 'wave'])
  })

  it('defaults to wave', () => {
    assert.equal(DEFAULT_APP_ICON_VARIANT, 'wave')
  })

  it('validates known variants', () => {
    assert.equal(isAppIconVariant('classic'), true)
    assert.equal(isAppIconVariant('wave'), true)
    assert.equal(isAppIconVariant('other'), false)
    assert.equal(isAppIconVariant(null), false)
  })
})
