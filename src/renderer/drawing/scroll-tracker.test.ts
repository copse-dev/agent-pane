import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { trackGuestScroll, SCROLL_TRACK_INTERVAL_MS, type ScrollTimer } from './scroll-tracker.ts'
import type { GuestScrollPosition } from '@shared/browser-guest-scroll.ts'

interface FakeTimer extends ScrollTimer {
  fireInterval: () => void
  runTimeouts: () => void
}

/**
 * A controllable clock: timers are registered and fired by hand so the poll
 * loop's cadence and idle-stop are asserted deterministically.
 */
function fakeTimer(): FakeTimer {
  const timeouts: (() => void)[] = []
  const intervals: (() => void)[] = []
  let nextHandle = 1
  return {
    setTimeout: (handler: () => void): number => {
      timeouts.push(handler)
      return nextHandle++
    },
    clearTimeout: (): void => {
      timeouts.length = 0
    },
    setInterval: (handler: () => void): number => {
      intervals.push(handler)
      return nextHandle++
    },
    clearInterval: (): void => {
      intervals.length = 0
    },
    fireInterval: (): void => {
      for (const fn of [...intervals]) fn()
    },
    runTimeouts: (): void => {
      for (const fn of timeouts.splice(0)) fn()
    },
  }
}

function wheelTarget(): { target: HTMLElement; wheel: () => void } {
  const target = document.createElement('div')
  document.body.append(target)
  return {
    target,
    wheel: (): void => {
      target.dispatchEvent(new window.Event('wheel', { bubbles: true }))
    },
  }
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('trackGuestScroll', () => {
  it('reports only changed positions and idles without input', async () => {
    const timers = fakeTimer()
    const { target, wheel } = wheelTarget()
    const positions: GuestScrollPosition[] = []
    let current: GuestScrollPosition = { x: 0, y: 0 }
    const tracker = trackGuestScroll({
      wheelTarget: target,
      fetchPosition: () => Promise.resolve(current),
      onScroll: (p) => {
        positions.push(p)
      },
      timer: timers,
    })
    try {
      // The first successful read establishes the baseline; only movement
      // after it is reported.
      wheel()
      await flush()
      assert.deepEqual(positions, [{ x: 0, y: 0 }])

      current = { x: 0, y: 300 }
      timers.fireInterval()
      await flush()
      assert.deepEqual(positions, [
        { x: 0, y: 0 },
        { x: 0, y: 300 },
      ])

      current = { x: 0, y: 260 }
      timers.fireInterval()
      await flush()
      assert.deepEqual(positions, [
        { x: 0, y: 0 },
        { x: 0, y: 300 },
        { x: 0, y: 260 },
      ])

      // Polling stops once the idle timeout fires — no wheel, no work.
      timers.runTimeouts()
      current = { x: 0, y: 100 }
      timers.fireInterval()
      await flush()
      assert.equal(positions.length, 3, 'idle tracker does not poll')

      // Fresh wheel activity wakes it again.
      wheel()
      await flush()
      assert.deepEqual(positions.at(-1), { x: 0, y: 100 })
    } finally {
      tracker.dispose()
      target.remove()
    }
  })

  it('kick polls immediately, even when idle', async () => {
    const timers = fakeTimer()
    const { target } = wheelTarget()
    const seen: GuestScrollPosition[] = []
    const tracker = trackGuestScroll({
      wheelTarget: target,
      fetchPosition: () => Promise.resolve({ x: 0, y: 42 }),
      onScroll: (p) => {
        seen.push(p)
      },
      timer: timers,
    })
    try {
      tracker.kick()
      await flush()
      assert.deepEqual(seen, [{ x: 0, y: 42 }])
    } finally {
      tracker.dispose()
      target.remove()
    }
  })

  it('keeps polling while a pointer stroke is down, and stops after dispose', async () => {
    const timers = fakeTimer()
    const { target } = wheelTarget()
    let calls = 0
    const tracker = trackGuestScroll({
      wheelTarget: target,
      fetchPosition: () => {
        calls += 1
        return Promise.resolve({ x: 0, y: 0 })
      },
      onScroll: () => {},
      timer: timers,
    })
    try {
      window.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      timers.fireInterval()
      await flush()
      const duringStroke = calls
      assert.ok(duringStroke >= 1, 'polls during a stroke')
      timers.runTimeouts() // idle timeout has no say while the stroke is down
      timers.fireInterval()
      await flush()
      assert.ok(calls > duringStroke, 'still polling with pointer held')

      tracker.dispose()
      const settled = calls
      window.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      timers.fireInterval()
      await flush()
      assert.equal(calls, settled, 'no polling after dispose')
    } finally {
      tracker.dispose()
      target.remove()
    }
  })

  it('survives a fetch failure and keeps polling', async () => {
    const timers = fakeTimer()
    const { target } = wheelTarget()
    let fail = true
    const seen: GuestScrollPosition[] = []
    const tracker = trackGuestScroll({
      wheelTarget: target,
      fetchPosition: () => {
        if (fail) return Promise.reject(new Error('guest gone'))
        return Promise.resolve({ x: 5, y: 6 })
      },
      onScroll: (p) => {
        seen.push(p)
      },
      timer: timers,
    })
    try {
      tracker.kick()
      await flush()
      fail = false
      timers.fireInterval()
      await flush()
      assert.deepEqual(seen, [{ x: 5, y: 6 }])
    } finally {
      tracker.dispose()
      target.remove()
    }
  })
})

describe('SCROLL_TRACK_INTERVAL_MS', () => {
  it('is a human-scale polling cadence', () => {
    assert.equal(SCROLL_TRACK_INTERVAL_MS, 80)
  })
})
