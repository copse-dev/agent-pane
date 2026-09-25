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
  addEventListener(
    type: 'wheel' | 'pointerdown',
    listener: (event: Event) => void,
    options?: object | boolean,
  ): void
  removeEventListener(
    type: 'wheel' | 'pointerdown',
    listener: (event: Event) => void,
    options?: boolean,
  ): void
}

/** Pointer listeners are captured and removed with `useCapture`, matching add/remove pairing. */
const CAPTURE = true

/** A guest scroll tracker; see {@link trackGuestScroll}. */
export interface GuestScrollTracker {
  /** Caller-driven nudge: navigation committed, size changed, layer shown. No-op while disabled. */
  kick(): void
  /**
   * Run only while it is worth an IPC per poll — marks exist or the layer is
   * active, and the guest is on screen. Disabling stops every timer and
   * listener; enabling re-reads the position at once, since the page may have
   * moved while nothing watched it.
   */
  setEnabled(enabled: boolean): void
  dispose(): void
}

/**
 * A `<webview>` gives its embedder no scroll events: the offset lives in the
 * guest process, and scroll is composited without so much as a repaint
 * notification crossing the boundary. This tracker watches for the signals
 * that precede movement — wheel input over the host, a stroke started on the
 * host, or a navigation/size change the caller reports — and polls the guest's
 * `window.scrollX/Y` through `fetchPosition` while any of them is live, then
 * goes quiet. A slow safety poll covers keyboard/scrollbar drags, which the
 * embedder cannot observe at all. Nothing runs while the tracker is disabled.
 */
export function trackGuestScroll(options: {
  /** Receives wheel and stroke-start input on the overlay's host element. */
  wheelTarget: WheelTarget
  /** Reads the guest's current offsets; returns null when it cannot answer. */
  fetchPosition: () => Promise<GuestScrollPosition | null>
  /** Called only when the position actually changed. */
  onScroll: (position: GuestScrollPosition) => void
  /** Injected for tests; defaults to the window timers. */
  timer?: ScrollTimer
}): GuestScrollTracker {
  const timer = options.timer ?? window

  let lastX: number | null = null
  let lastY: number | null = null
  let strokeDepth = 0
  let disposed = false
  let enabled = false
  let polling = false
  let inFlight = false
  let idleTimer: number | null = null
  let interval: number | null = null
  let safetyInterval: number | null = null

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
    if (disposed || !enabled || inFlight || (!force && !polling && strokeDepth === 0)) return
    inFlight = true
    void options
      .fetchPosition()
      .then((position) => {
        // A failed read (null) keeps the last position rather than snapping
        // every mark to the page origin.
        if (!disposed && position) emit(position)
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  const wake = (): void => {
    if (!enabled) return
    polling = true
    scheduleIdleStop()
    poll()
  }

  const onWheel = (): void => {
    wake()
  }
  // Strokes start on the overlay inside the host, so the host hears them; a
  // window-wide listener would make every click anywhere cost one IPC per tracker.
  const onPointerDown = (): void => {
    strokeDepth += 1
    poll()
  }
  const onPointerUp = (): void => {
    strokeDepth = Math.max(0, strokeDepth - 1)
  }

  const start = (): void => {
    enabled = true
    interval = timer.setInterval(poll, SCROLL_TRACK_INTERVAL_MS)
    safetyInterval = timer.setInterval(() => {
      poll(true)
    }, SCROLL_SAFETY_INTERVAL_MS)
    options.wheelTarget.addEventListener('wheel', onWheel, { passive: true })
    options.wheelTarget.addEventListener('pointerdown', onPointerDown, CAPTURE)
    // The release can land outside the host, so it is heard window-wide; it
    // only settles a counter and never polls.
    window.addEventListener('pointerup', onPointerUp, CAPTURE)
    window.addEventListener('pointercancel', onPointerUp, CAPTURE)
    wake()
  }

  const stop = (): void => {
    enabled = false
    polling = false
    strokeDepth = 0
    if (interval !== null) timer.clearInterval(interval)
    if (safetyInterval !== null) timer.clearInterval(safetyInterval)
    interval = null
    safetyInterval = null
    if (idleTimer !== null) timer.clearTimeout(idleTimer)
    idleTimer = null
    options.wheelTarget.removeEventListener('wheel', onWheel)
    options.wheelTarget.removeEventListener('pointerdown', onPointerDown, CAPTURE)
    window.removeEventListener('pointerup', onPointerUp, CAPTURE)
    window.removeEventListener('pointercancel', onPointerUp, CAPTURE)
  }

  start()

  return {
    kick: wake,
    setEnabled(next: boolean): void {
      if (disposed || next === enabled) return
      if (next) start()
      else stop()
    },
    dispose(): void {
      if (enabled) stop()
      disposed = true
    },
  }
}
