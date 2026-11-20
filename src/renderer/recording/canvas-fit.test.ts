import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evenFrameSize, fitRect } from './canvas-fit.ts'

describe('evenFrameSize', () => {
  it('rounds odd dimensions down to even for 4:2:0 encoding', () => {
    assert.deepEqual(evenFrameSize(321, 181), { width: 320, height: 180 })
    assert.deepEqual(evenFrameSize(320, 180), { width: 320, height: 180 })
  })

  it('never returns an empty frame', () => {
    assert.deepEqual(evenFrameSize(1, 0), { width: 2, height: 2 })
  })
})

describe('fitRect', () => {
  it('fills the frame when the aspect matches', () => {
    assert.deepEqual(fitRect(640, 360, 320, 180), { x: 0, y: 0, width: 320, height: 180 })
  })

  it('pillarboxes a taller source and letterboxes a wider one', () => {
    assert.deepEqual(fitRect(180, 180, 320, 180), { x: 70, y: 0, width: 180, height: 180 })
    assert.deepEqual(fitRect(640, 180, 320, 180), { x: 0, y: 45, width: 320, height: 90 })
  })

  it('covers the frame when the source has no size yet', () => {
    assert.deepEqual(fitRect(0, 0, 320, 180), { x: 0, y: 0, width: 320, height: 180 })
  })
})
