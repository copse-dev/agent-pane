import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFrameLoop, type FrameSource } from './frame-loop.ts'

/** A frame source driven by hand: `advance(ms)` runs the pending frame. */
function manualFrames(options: { animate?: boolean } = {}): FrameSource & {
  advance: (ms: number) => void
  pending: () => boolean
} {
  let time = 0
  let queued: (() => void) | null = null
  let nextHandle = 1
  return {
    now: () => time,
    request: (callback: () => void): number => {
      queued = callback
      return nextHandle++
    },
    cancel: (): void => {
      queued = null
    },
    canAnimate: () => options.animate ?? true,
    advance: (ms: number): void => {
      time += ms
      const run = queued
      queued = null
      run?.()
    },
    pending: () => queued !== null,
  }
}

const FRAME_MS = 1000 / 60

describe('createFrameLoop', () => {
  it('finishes in one step on a frame source that runs callbacks synchronously', () => {
    const synchronous: FrameSource = {
      now: () => 0,
      request: (callback) => {
        callback()
        return 0
      },
      cancel: () => {},
      canAnimate: () => true,
    }
    const steps: number[] = []
    const loop = createFrameLoop((dt) => {
      steps.push(dt)
      return true
    }, synchronous)
    loop.start()
    assert.deepEqual(steps, [Infinity])
  })

  it('finishes in one step when motion is off', () => {
    const frames = manualFrames({ animate: false })
    const steps: number[] = []
    createFrameLoop((dt) => {
      steps.push(dt)
      return true
    }, frames).start()
    assert.deepEqual(steps, [Infinity])
    assert.equal(frames.pending(), false)
  })

  it('finishes in one step after a long stall, such as a hidden window', () => {
    const frames = manualFrames()
    const steps: number[] = []
    createFrameLoop((dt) => {
      steps.push(dt)
      return true
    }, frames).start()
    frames.advance(2_000)
    assert.deepEqual(steps, [Infinity])
  })

  it('stops requesting frames once the step is done', () => {
    const frames = manualFrames()
    let remaining = 3
    const loop = createFrameLoop(() => --remaining > 0, frames)
    loop.start()
    frames.advance(FRAME_MS)
    frames.advance(FRAME_MS)
    assert.equal(frames.pending(), true)
    frames.advance(FRAME_MS)
    assert.equal(frames.pending(), false)
  })
})
