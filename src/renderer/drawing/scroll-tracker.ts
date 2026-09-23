import type { GuestScrollPosition } from '@shared/browser-guest-scroll.ts'

/**
 * The DOM timer surface the tracker uses. Structural, not `typeof setTimeout`:
 * in Electron's renderer the global timer functions exist but stay uncallable
 * in some test doubles, so the tracker only relies on this narrow contract.
 */
export interface ScrollTimer {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
}

/** Minimum gap between guest scroll polls; scroll events arrive in bursts. */
export const SCROLL_TRACK_INTERVAL_MS = 80
/** Covers keyboard, scrollbar, and guest-process scrolling invisible to the embedder. */
export const SCROLL_SAFETY_INTERVAL_MS = 1_000
/** Wheel noise dies down within a turn; an active stroke keeps polling alive. */
const IDLE_STOP_MS = 1_000

interface WheelTarget {
  addEventListener(type: 'wheel', listener: (event: Event) => void, options?: object): void
  removeEventListener(type: 'wheel', listener: (event: Event) => void): void
}

/** Window listeners are captured and removed with `useCapture`, matching add/remove pairing. */
const CAPTURE = true

/**
 * A `<webview>` gives its embedder no scroll events: the offset lives in the
 * guest process, and scroll is composited without so much as a repaint
 * notification crossing the boundary. This tracker watches for the signals
 * that precede movement — wheel input over the host, an in-progress stroke,
 * or a navigation/size change the caller reports — and polls the guest's
 * `window.scrollX/Y` through `fetchPosition` while any of them is live, then
 * goes quiet. A slow safety poll covers keyboard/scrollbar drags, which the
 * embedder cannot observe at all.
 */
export function trackGuestScroll(options: {
  /** Receives wheel activity on the overlay's host element. */
  wheelTarget: WheelTarget
  /** Reads the guest's current offsets; returns null when it cannot answer. */
  fetchPosition: () => Promise<GuestScrollPosition | null>
  /** Called only when the position actually changed. */
  onScroll: (position: GuestScrollPosition) => void
  /** Injected for tests; defaults to the window timers. */
  timer?: ScrollTimer
}): { kick: () => void; dispose: () => void } {
  const timer = options.timer ?? window

  let lastX: number | null = null
  let lastY: number | null = null
  let strokeDepth = 0
  let disposed = false
  let polling = false
  let inFlight = false
  let idleTimer: number | null = null

  const emit = (position: GuestScrollPosition): void => {
    if (position.x === lastX && position.y === lastY) return
    lastX = position.x
    lastY = position.y
    options.onScroll(position)
  }

  const scheduleIdleStop = (): void => {
    if (idleTimer !== null) timer.clearTimeout(idleTimer)
    idleTimer = timer.setTimeout(() => {
      idleTimer = null
      polling = false
    }, IDLE_STOP_MS)
  }

  const poll = (force = false): void => {
    if (disposed || inFlight || (!force && !polling && strokeDepth === 0)) return
    inFlight = true
    void options
      .fetchPosition()
      .then((position) => {
        if (!disposed && position) emit(position)
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  const interval = timer.setInterval(poll, SCROLL_TRACK_INTERVAL_MS)
  const safetyInterval = timer.setInterval(() => {
    poll(true)
  }, SCROLL_SAFETY_INTERVAL_MS)

  const wake = (): void => {
    polling = true
    scheduleIdleStop()
    poll()
  }

  const onWheel = (): void => {
    wake()
  }
  const onPointerDown = (): void => {
    strokeDepth += 1
    poll()
  }
  const onPointerUp = (): void => {
    strokeDepth = Math.max(0, strokeDepth - 1)
  }

  options.wheelTarget.addEventListener('wheel', onWheel, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, CAPTURE)
  window.addEventListener('pointerup', onPointerUp, CAPTURE)
  window.addEventListener('pointercancel', onPointerUp, CAPTURE)

  return {
    /** Caller-driven nudge: navigation committed, size changed, layer shown. */
    kick: wake,
    dispose(): void {
      disposed = true
      timer.clearInterval(interval)
      timer.clearInterval(safetyInterval)
      if (idleTimer !== null) timer.clearTimeout(idleTimer)
      options.wheelTarget.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerdown', onPointerDown, CAPTURE)
      window.removeEventListener('pointerup', onPointerUp, CAPTURE)
      window.removeEventListener('pointercancel', onPointerUp, CAPTURE)
    },
  }
}
