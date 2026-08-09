import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  driverVerboseOptions,
  shouldEnableDriverVerbose,
} from '../tests/e2e/helpers/driver-verbose.ts'

describe('shouldEnableDriverVerbose', () => {
  it('is on in CI by default', () => {
    // The load-bearing case: the evidence that diagnosed #1606 existed only
    // because verbose was already on when the failure happened.
    assert.equal(shouldEnableDriverVerbose({ CI: 'true' }), true)
  })

  it('is off locally by default', () => {
    assert.equal(shouldEnableDriverVerbose({}), false)
  })

  it('can be forced on locally', () => {
    assert.equal(shouldEnableDriverVerbose({ COPSE_E2E_DRIVER_VERBOSE: '1' }), true)
  })

  it('can be forced off in CI', () => {
    assert.equal(shouldEnableDriverVerbose({ CI: 'true', COPSE_E2E_DRIVER_VERBOSE: '0' }), false)
  })

  it('reads the usual spellings of off', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
      assert.equal(
        shouldEnableDriverVerbose({ CI: 'true', COPSE_E2E_DRIVER_VERBOSE: value }),
        false,
        `${value} should read as off`,
      )
    }
  })

  it('treats an explicitly falsy CI as not CI', () => {
    // Some runners export CI=false rather than leaving it unset; a bare
    // truthiness check would call that "in CI".
    assert.equal(shouldEnableDriverVerbose({ CI: 'false' }), false)
    assert.equal(shouldEnableDriverVerbose({ CI: '0' }), false)
  })

  it('ignores whitespace-only values rather than reading them as on', () => {
    assert.equal(shouldEnableDriverVerbose({ CI: 'true', COPSE_E2E_DRIVER_VERBOSE: '  ' }), true)
    assert.equal(shouldEnableDriverVerbose({ COPSE_E2E_DRIVER_VERBOSE: '  ' }), false)
  })
})

describe('driverVerboseOptions', () => {
  it('omits the key entirely when off', () => {
    // wdio turns every key in chromedriverOptions into a CLI flag, so
    // `verbose: false` would still pass `--verbose`.
    assert.deepEqual(driverVerboseOptions({}), {})
    assert.equal('verbose' in driverVerboseOptions({}), false)
  })

  it('sets verbose when on', () => {
    assert.deepEqual(driverVerboseOptions({ CI: 'true' }), { verbose: true })
  })
})
