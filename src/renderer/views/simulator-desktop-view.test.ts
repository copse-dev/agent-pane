import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulatorDesktopViewInternals } from './simulator-desktop-view.ts'

describe('Simulator desktop keyboard mapping', () => {
  it('maps common DOM key codes to USB HID usages', () => {
    assert.equal(simulatorDesktopViewInternals.keyUsage('KeyA'), 4)
    assert.equal(simulatorDesktopViewInternals.keyUsage('KeyZ'), 29)
    assert.equal(simulatorDesktopViewInternals.keyUsage('Digit1'), 30)
    assert.equal(simulatorDesktopViewInternals.keyUsage('Digit0'), 39)
    assert.equal(simulatorDesktopViewInternals.keyUsage('Enter'), 40)
    assert.equal(simulatorDesktopViewInternals.keyUsage('ArrowUp'), 82)
    assert.equal(simulatorDesktopViewInternals.keyUsage('AudioVolumeUp'), null)
  })
})
