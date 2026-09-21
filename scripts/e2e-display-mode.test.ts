import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  shouldRunE2eHeadless,
  shouldUseChromiumHeadless,
  shouldUseLinuxVirtualDisplay,
} from '../tests/e2e/helpers/display-mode.mts'

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

  it('uses Chromium headless only on platforms where Electron supports it', () => {
    assert.equal(shouldUseChromiumHeadless('darwin', {}), true)
    assert.equal(shouldUseChromiumHeadless('win32', {}), true)
    assert.equal(shouldUseChromiumHeadless('linux', {}), false)
    assert.equal(shouldUseChromiumHeadless('darwin', { COPSE_E2E_HEADLESS: '0' }), false)
  })

  it('uses an isolated virtual display for non-visible Linux runs', () => {
    assert.equal(shouldUseLinuxVirtualDisplay('linux', { DISPLAY: ':1' }), true)
    assert.equal(
      shouldUseLinuxVirtualDisplay('linux', {
        DISPLAY: ':1',
        COPSE_E2E_HEADLESS: '0',
      }),
      false,
    )
    assert.equal(shouldUseLinuxVirtualDisplay('linux', { COPSE_E2E_HEADLESS: '0' }), true)
    assert.equal(shouldUseLinuxVirtualDisplay('darwin', {}), false)
  })
})
