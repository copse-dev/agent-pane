import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { attachVisualPinchZoom } from './visual-pinch-zoom.ts'

describe('attachVisualPinchZoom', () => {
  it('enables transient visual zoom after every renderer load', () => {
    const calls: Array<[number, number]> = []
    const didFinishLoad: Array<() => void> = []

    attachVisualPinchZoom({
      on(_event, listener) {
        didFinishLoad.push(listener)
      },
      setVisualZoomLevelLimits(minimumLevel, maximumLevel) {
        calls.push([minimumLevel, maximumLevel])
        return Promise.resolve()
      },
    })

    assert.deepEqual(calls, [])
    assert.equal(didFinishLoad.length, 1)
    const listener = didFinishLoad[0]
    assert.ok(listener)
    listener()
    listener()
    assert.deepEqual(calls, [
      [1, 3],
      [1, 3],
    ])
  })
})
