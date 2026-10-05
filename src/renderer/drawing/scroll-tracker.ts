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
  /**
   * Caller-driven nudge: navigation committed, size changed, layer shown. Replays the last known
   * offset so consumers can refresh size-dependent layout even when the guest did not scroll.
   * No-op while disabled.
   */
  kick(): void
  /**
   * Run only while it is worth an IPC per poll — marks exist or the layer is
   * active, and the guest is on screen. Disabling stops every timer and
   * listener; enabling re-reads the position at once, since the page may have
   * moved while nothing watched it.
   */
  setEnabled(enabled: boolean): void
  /**
   * The guest has (or lost) keyboard/pointer focus. Guest-only input such as PageDown or a
   * scrollbar drag never reaches the host, so while the guest is focused polling does not idle
   * out; it settles into the normal idle stop once focus leaves.
   */
  setGuestFocused(focused: boolean): void
  dispose(): void
}

/**
 * A `<webview>` gives its embedder no scroll events: the offset lives in the
 * guest process, and scroll is composited without so much as a repaint
 * notification crossing the boundary. This tracker watches for the signals
 * that precede movement — wheel input over the host, a stroke started on the
 * host, or a navigation/size change the caller reports — and polls the guest's
 * `window.scrollX/Y` through `fetchPosition` during that bounded activity
 * burst, then clears its polling timer and goes quiet. Nothing runs while the
 * tracker is disabled or idle.
 */
export function trackGuestScroll(options: {
  /** Receives wheel and stroke-start input on the overlay's host element. */
  wheelTarget: WheelTarget
  /** Reads the guest's current offsets; returns null when it cannot answer. */
  fetchPosition: () => Promise<GuestScrollPosition | null>
  /** Called when the position changes or a caller-driven refresh replays the last known offset. */
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
  let guestFocused = false
  let inFlight = false
  let idleTimer: number | null = null
  let interval: number | null = null

  const emit = (position: GuestScrollPosition): void => {
    if (position.x === lastX && position.y === lastY) return
    lastX = position.x
    lastY = position.y
    options.onScroll(position)
  }

  const stopPolling = (): void => {
    if (interval !== null) timer.clearInterval(interval)
    interval = null
  }

  const startPolling = (): void => {
    interval ??= timer.setInterval(poll, SCROLL_TRACK_INTERVAL_MS)
  }

  const scheduleIdleStop = (): void => {
    if (idleTimer !== null) timer.clearTimeout(idleTimer)
    idleTimer = timer.setTimeout(() => {
      idleTimer = null
      polling = false
      if (strokeDepth === 0 && !guestFocused) stopPolling()
    }, IDLE_STOP_MS)
  }

  function poll(): void {
    if (disposed || !enabled || inFlight || (!polling && strokeDepth === 0 && !guestFocused)) return
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

  const wake = (refreshLayout = false): void => {
    if (!enabled) return
    if (refreshLayout && lastX !== null && lastY !== null) {
      options.onScroll({ x: lastX, y: lastY })
    }
    polling = true
    startPolling()
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
    startPolling()
    poll()
  }
  const onPointerUp = (): void => {
    strokeDepth = Math.max(0, strokeDepth - 1)
    if (strokeDepth === 0 && !polling && !guestFocused) stopPolling()
  }

  const start = (refreshLayout = false): void => {
    enabled = true
    options.wheelTarget.addEventListener('wheel', onWheel, { passive: true })
    options.wheelTarget.addEventListener('pointerdown', onPointerDown, CAPTURE)
    // The release can land outside the host, so it is heard window-wide; it
    // only settles a counter and never polls.
    window.addEventListener('pointerup', onPointerUp, CAPTURE)
    window.addEventListener('pointercancel', onPointerUp, CAPTURE)
    wake(refreshLayout)
  }

  const stop = (): void => {
    enabled = false
    polling = false
    strokeDepth = 0
    stopPolling()
    if (idleTimer !== null) timer.clearTimeout(idleTimer)
    idleTimer = null
    options.wheelTarget.removeEventListener('wheel', onWheel)
    options.wheelTarget.removeEventListener('pointerdown', onPointerDown, CAPTURE)
    window.removeEventListener('pointerup', onPointerUp, CAPTURE)
    window.removeEventListener('pointercancel', onPointerUp, CAPTURE)
  }

  start()

  return {
    kick: (): void => {
      wake(true)
    },
    setEnabled(next: boolean): void {
      if (disposed || next === enabled) return
      if (next) start(true)
      else stop()
    },
    setGuestFocused(focused: boolean): void {
      if (disposed || focused === guestFocused) return
      guestFocused = focused
      if (focused) wake()
      else if (!polling && strokeDepth === 0) stopPolling()
    },
    dispose(): void {
      if (enabled) stop()
      disposed = true
    },
  }
}
