import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldRunE2eHeadless } from '../tests/e2e/helpers/display-mode.mts'

describe('shouldRunE2eHeadless', () => {
  it('defaults to headless', () => {
    assert.equal(shouldRunE2eHeadless({}), true)
    assert.equal(shouldRunE2eHeadless({ COPSE_E2E_HEADLESS: '' }), true)
  })

  it('supports an explicit headed debugging run', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
      assert.equal(
        shouldRunE2eHeadless({ COPSE_E2E_HEADLESS: value }),
        false,
        `${value} should opt out of headless mode`,
      )
    }
  })

  it('treats other explicit values as headless', () => {
    assert.equal(shouldRunE2eHeadless({ COPSE_E2E_HEADLESS: '1' }), true)
    assert.equal(shouldRunE2eHeadless({ COPSE_E2E_HEADLESS: 'true' }), true)
  })
})
