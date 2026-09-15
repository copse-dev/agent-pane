import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createSimulatorDesktopView,
  simulatorDesktopViewInternals,
} from './simulator-desktop-view.ts'
import type { SimulatorDesktopInput } from '@shared/types/simulator-desktop.ts'

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

describe('Emulator touch lifecycle', () => {
  for (const finish of ['disable', 'blur', 'cleanup'] as const) {
    it(`releases a drag when control ends through ${finish}`, () => {
      const inputs: SimulatorDesktopInput[] = []
      const view = createSimulatorDesktopView({
        connectionId: 'test',
        sendInput: (input) => {
          inputs.push(input)
          return Promise.resolve()
        },
        onFirstFrame: () => {},
        onInputError: (error) => {
          throw error
        },
      })
      view.canvas.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 200)
      view.canvas.setPointerCapture = (): void => {}
      view.canvas.hasPointerCapture = (): boolean => true
      view.canvas.releasePointerCapture = (): void => {}
      view.setControlEnabled(true)
      view.canvas.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 25, clientY: 100 }),
      )
      // A second finger must not steal the first pointer's release.
      view.canvas.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 2, button: 0, clientX: 90, clientY: 190 }),
      )
      if (finish === 'disable') view.setControlEnabled(false)
      if (finish === 'blur') view.canvas.dispatchEvent(new Event('blur'))
      view.cleanup()
      assert.deepEqual(inputs, [
        { type: 'touch', phase: 'down', x: 0.25, y: 0.5 },
        { type: 'touch', phase: 'up', x: 0.25, y: 0.5 },
      ])
    })
  }
})
