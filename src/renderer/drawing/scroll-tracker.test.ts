import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  trackGuestScroll,
  SCROLL_SAFETY_INTERVAL_MS,
  SCROLL_TRACK_INTERVAL_MS,
  type ScrollTimer,
} from './scroll-tracker.ts'
import type { GuestScrollPosition } from '@shared/browser-guest-scroll.ts'

interface FakeTimer extends ScrollTimer {
  fireInterval: (ms?: number) => void
  runTimeouts: () => void
}

/**
 * A controllable clock: timers are registered and fired by hand so the poll
 * loop's cadence and idle-stop are asserted deterministically.
 */
function fakeTimer(): FakeTimer {
  const timeouts: (() => void)[] = []
  const intervals = new Map<number, { handler: () => void; ms: number }>()
  let nextHandle = 1
  return {
    setTimeout: (handler: () => void): number => {
      timeouts.push(handler)
      return nextHandle++
    },
    clearTimeout: (): void => {
      timeouts.length = 0
    },
    setInterval: (handler: () => void, ms: number): number => {
      const handle = nextHandle++
      intervals.set(handle, { handler, ms })
      return handle
    },
    clearInterval: (handle: number): void => {
      intervals.delete(handle)
    },
    fireInterval: (ms = SCROLL_TRACK_INTERVAL_MS): void => {
      for (const interval of intervals.values()) {
        if (interval.ms === ms) interval.handler()
      }
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

      // Keyboard and scrollbar movement happens inside the guest and cannot
      // wake the embedder, so the slower safety interval still observes it.
      timers.fireInterval(SCROLL_SAFETY_INTERVAL_MS)
      await flush()
      assert.deepEqual(positions.at(-1), { x: 0, y: 100 })

      // Fresh wheel activity wakes it again.
      current = { x: 0, y: 80 }
      wheel()
      await flush()
      assert.deepEqual(positions.at(-1), { x: 0, y: 80 })
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
      await flush()
      timers.runTimeouts() // let the creation read go idle
      target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
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
      target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
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

describe('trackGuestScroll lifecycle', () => {
  function counted(): {
    tracker: ReturnType<typeof trackGuestScroll>
    target: HTMLElement
    wheel: () => void
    timers: FakeTimer
    calls: () => number
    seen: GuestScrollPosition[]
    setAnswer: (answer: GuestScrollPosition | null) => void
  } {
    const timers = fakeTimer()
    const { target, wheel } = wheelTarget()
    let calls = 0
    let answer: GuestScrollPosition | null = { x: 0, y: 0 }
    const seen: GuestScrollPosition[] = []
    const tracker = trackGuestScroll({
      wheelTarget: target,
      fetchPosition: () => {
        calls += 1
        return Promise.resolve(answer)
      },
      onScroll: (p) => {
        seen.push(p)
      },
      timer: timers,
    })
    return {
      tracker,
      target,
      wheel,
      timers,
      calls: () => calls,
      seen,
      setAnswer: (next: GuestScrollPosition | null): void => {
        answer = next
      },
    }
  }

  it('reads the position as soon as it starts, without waiting for input', async () => {
    const t = counted()
    try {
      t.setAnswer({ x: 0, y: 420 })
      await flush()
      assert.deepEqual(t.seen, [{ x: 0, y: 0 }], 'the creation read is the baseline')
      t.tracker.kick()
      await flush()
      assert.deepEqual(t.seen.at(-1), { x: 0, y: 420 })
    } finally {
      t.tracker.dispose()
      t.target.remove()
    }
  })

  it('does nothing while disabled, and re-reads at once when enabled again', async () => {
    const t = counted()
    try {
      await flush()
      t.tracker.setEnabled(false)
      const before = t.calls()
      t.setAnswer({ x: 0, y: 900 })
      t.wheel()
      t.target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      t.tracker.kick()
      t.timers.fireInterval()
      t.timers.fireInterval(SCROLL_SAFETY_INTERVAL_MS)
      await flush()
      assert.equal(t.calls(), before, 'no timers, listeners or kicks while disabled')

      t.tracker.setEnabled(true)
      await flush()
      assert.equal(t.calls(), before + 1)
      assert.deepEqual(t.seen.at(-1), { x: 0, y: 900 }, 'movement while paused is picked up')
    } finally {
      t.tracker.dispose()
      t.target.remove()
    }
  })

  it('ignores pointer input outside its own host', async () => {
    const t = counted()
    try {
      await flush()
      t.timers.runTimeouts()
      const before = t.calls()
      window.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      t.timers.fireInterval()
      await flush()
      assert.equal(t.calls(), before, 'a click elsewhere in the app costs no IPC')
    } finally {
      t.tracker.dispose()
      t.target.remove()
    }
  })

  it('keeps the last position when the guest cannot answer', async () => {
    const t = counted()
    try {
      t.setAnswer({ x: 0, y: 300 })
      await flush()
      t.tracker.kick()
      await flush()
      t.setAnswer(null)
      t.tracker.kick()
      await flush()
      assert.deepEqual(t.seen.at(-1), { x: 0, y: 300 })
    } finally {
      t.tracker.dispose()
      t.target.remove()
    }
  })
})

describe('SCROLL_TRACK_INTERVAL_MS', () => {
  it('is a human-scale polling cadence', () => {
    assert.equal(SCROLL_TRACK_INTERVAL_MS, 80)
  })
})
