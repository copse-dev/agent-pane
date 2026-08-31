import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createWheelPump,
  DEFAULT_WHEEL_SPEED,
  FRAME_PIXEL_BUDGET,
  MAX_PENDING_PIXELS,
  MAX_WHEEL_SPEED,
  WHEEL_STEP,
  type WheelPump,
  type WheelStep,
} from './vnc-wheel.ts'

interface WheelHarness {
  pump: WheelPump
  steps: WheelStep[]
  /** Run one scheduled frame; returns false when the pump has nothing left to drain. */
  tick(): boolean
  drain(): number
  scrollY(deltaY: number): void
}

/** Drives the pump with an explicit frame clock so pacing is observable rather than timing-dependent. */
function harness(speed = DEFAULT_WHEEL_SPEED): WheelHarness {
  const steps: WheelStep[] = []
  const frames: (() => void)[] = []
  const pump = createWheelPump({
    speed,
    emit: (step) => steps.push(step),
    schedule: (run) => frames.push(run),
  })
  const tick = (): boolean => {
    const run = frames.shift()
    if (!run) return false
    run()
    return true
  }
  return {
    pump,
    steps,
    tick,
    drain(): number {
      let count = 0
      while (tick()) count++
      return count
    },
    scrollY(deltaY: number): void {
      pump.push({ deltaX: 0, deltaY, deltaMode: 0 })
    },
  }
}

describe('createWheelPump', () => {
  it('keeps every step of a fast flick instead of noVNC’s single step per event', () => {
    const h = harness(1)

    h.scrollY(400)
    h.drain()

    assert.equal(h.steps.length, 8)
    assert.deepEqual(h.steps[0], { deltaX: 0, deltaY: WHEEL_STEP })
  })

  it('paces the steps across frames rather than firing them in one burst', () => {
    const h = harness(1)
    const perFrame = FRAME_PIXEL_BUDGET / WHEEL_STEP

    h.scrollY(4 * FRAME_PIXEL_BUDGET)
    // The leading steps go out inside the gesture's own event so scrolling starts immediately.
    assert.equal(h.steps.length, perFrame)

    h.tick()
    assert.equal(h.steps.length, 2 * perFrame)
    h.tick()
    assert.equal(h.steps.length, 3 * perFrame)
    h.tick()
    assert.equal(h.steps.length, 4 * perFrame)
    assert.equal(h.tick(), false)
  })

  it('holds gesture throughput steady as the speed rises, so pacing costs no travel', () => {
    const slow = harness(1)
    const fast = harness(MAX_WHEEL_SPEED)

    slow.scrollY(4 * FRAME_PIXEL_BUDGET)
    fast.scrollY(4 * FRAME_PIXEL_BUDGET)

    // One frame of each moves the same distance of gesture; the fast pump just spends it on
    // more, finer clicks. Anything else would make a higher speed scroll *less* per second.
    assert.equal(slow.steps.length * (WHEEL_STEP / 1), FRAME_PIXEL_BUDGET)
    assert.equal(Math.round(fast.steps.length * (WHEEL_STEP / MAX_WHEEL_SPEED)), FRAME_PIXEL_BUDGET)
  })

  it('keeps up with a hard momentum flick instead of dropping its travel', () => {
    // The frame budget is a smoothing window, not a rate limit: whatever it holds back overflows
    // the backlog cap and is lost, which is the bug this file exists to fix. A macOS flick peaks
    // near 160px per event at 120Hz — two events a frame — and every pixel has to survive it.
    const h = harness(1)
    const perEvent = 160
    const events = 40

    for (let i = 0; i < events; i++) {
      h.scrollY(perEvent)
      if (i % 2 === 1) h.tick()
    }
    h.drain()

    assert.equal(h.steps.length, (events * perEvent) / WHEEL_STEP)
  })

  it('emits more clicks per pixel as the speed rises', () => {
    const slow = harness(1)
    const fast = harness(3)

    slow.scrollY(150)
    slow.drain()
    fast.scrollY(150)
    fast.drain()

    assert.equal(slow.steps.length, 3)
    assert.equal(fast.steps.length, 9)
  })

  it('replays each step at noVNC’s own threshold so one step is one click', () => {
    const h = harness(MAX_WHEEL_SPEED)

    h.scrollY(WHEEL_STEP)
    h.drain()

    assert.equal(h.steps.length, MAX_WHEEL_SPEED)
    assert.ok(h.steps.every((step) => step.deltaY === WHEEL_STEP))
  })

  it('carries the sub-step remainder so slow scrolling still accumulates', () => {
    const h = harness(1)

    h.scrollY(30)
    assert.equal(h.steps.length, 0)
    h.scrollY(30)
    assert.equal(h.steps.length, 1)
    h.scrollY(30)
    assert.equal(h.steps.length, 1)
    h.scrollY(30)
    assert.equal(h.steps.length, 2)
  })

  it('preserves direction and reports each axis separately', () => {
    const h = harness(1)

    h.pump.push({ deltaX: -100, deltaY: 50, deltaMode: 0 })
    h.drain()

    assert.deepEqual(h.steps, [
      { deltaX: 0, deltaY: WHEEL_STEP },
      { deltaX: -WHEEL_STEP, deltaY: 0 },
      { deltaX: -WHEEL_STEP, deltaY: 0 },
    ])
  })

  it('scales line and page units the way noVNC does', () => {
    const lines = harness(1)
    const pixels = harness(1)

    lines.pump.push({ deltaX: 0, deltaY: 3, deltaMode: 1 })
    lines.drain()
    pixels.pump.push({ deltaX: 0, deltaY: 3, deltaMode: 0 })
    pixels.drain()

    assert.equal(lines.steps.length, 1)
    assert.equal(pixels.steps.length, 0)
  })

  it('abandons the backlog when the scroll direction reverses', () => {
    const h = harness(1)

    h.scrollY(40)
    h.scrollY(-60)
    h.drain()

    assert.deepEqual(h.steps, [{ deltaX: 0, deltaY: -WHEEL_STEP }])
  })

  it('caps the backlog so a runaway flick does not drift on afterwards', () => {
    const h = harness(1)

    h.scrollY(100_000)
    assert.equal(h.drain() > 0, true)
    assert.equal(h.steps.length, MAX_PENDING_PIXELS / WHEEL_STEP)

    h.steps.length = 0
    h.scrollY(10)
    h.drain()
    assert.equal(h.steps.length, 0)
  })

  it('ignores non-finite deltas', () => {
    const h = harness(1)

    h.scrollY(Number.NaN)
    h.drain()
    assert.equal(h.steps.length, 0)

    h.scrollY(60)
    h.drain()
    assert.equal(h.steps.length, 1)
  })

  it('drops the backlog on reset', () => {
    const h = harness(1)

    h.scrollY(40)
    h.pump.reset()
    h.scrollY(40)
    h.drain()

    assert.equal(h.steps.length, 0)
  })

  it('clamps an out-of-range speed to the supported band', () => {
    const h = harness(1)

    h.pump.setSpeed(1_000)
    h.scrollY(WHEEL_STEP)
    h.drain()

    assert.equal(h.steps.length, MAX_WHEEL_SPEED)
  })
})
