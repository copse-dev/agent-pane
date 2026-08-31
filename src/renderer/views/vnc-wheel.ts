/**
 * RFB has no smooth-scroll message: a wheel reaches the remote desktop as discrete button-4/5/6/7
 * clicks, so the only levers a client has are how many clicks it emits and how it spaces them in
 * time. noVNC gets both wrong for a trackpad.
 *
 * Count: its handler emits at most one click per wheel event and then zeroes its accumulator, so
 * everything past the first 50px is discarded — a flick reporting 400px in one event loses seven
 * eighths of its travel.
 *
 * Spacing: replaying the missing clicks in the same tick is not enough on its own, because a
 * remote desktop that animates each wheel click collapses a same-millisecond burst into far less
 * scrolling than its click count. Steps have to arrive spread over time to read as motion.
 *
 * This pump does both. It accumulates wheel delta in pixels, converts it to whole steps at a
 * configurable gain, and drains a few steps per animation frame. The caller replays one
 * step-sized wheel event per emitted step, which noVNC forwards one for one.
 */

/** Delta a replayed event must carry to trip noVNC's threshold once (`WHEEL_STEP` in @novnc/novnc). */
export const WHEEL_STEP = 50

/** Pixels noVNC assumes per line when an event reports line or page units (`WHEEL_LINE_HEIGHT`). */
const WHEEL_LINE_HEIGHT = 19

/**
 * Gesture pixels allowed through per animation frame, so one oversized event is spread over a few
 * frames instead of arriving as a single burst. Budgeting in gesture pixels rather than steps
 * keeps throughput the same at every speed: raising the speed buys more clicks for the same
 * travel, not less travel per second.
 *
 * This is deliberately far above any real input rate. It is a smoothing window, not a rate limit —
 * a budget low enough to bind is indistinguishable from the bug this file exists to fix, because
 * whatever it holds back overflows the backlog cap below and is discarded. Measured against
 * noVNC's own handler, 100px/frame (~6000px/s) threw away 70% of a hard macOS momentum flick;
 * 400px/frame (~24000px/s at 60fps) clears the fastest flick a trackpad can produce.
 */
export const FRAME_PIXEL_BUDGET = 8 * WHEEL_STEP

/**
 * Backlog ceiling in gesture pixels, so a runaway flick stops near where the user let go instead
 * of drifting on. Only a gesture faster than the frame budget can reach it, and a full backlog
 * drains in five frames, so it bounds drift without costing travel.
 */
export const MAX_PENDING_PIXELS = 40 * WHEEL_STEP

/**
 * Speeds that do not divide `WHEEL_STEP` evenly leave femtometre residue behind after repeated
 * subtraction, which would swallow the last step of an exact-multiple gesture. Round it away.
 */
const STEP_EPSILON = 1e-9

/** Speed 1 is noVNC's own 50px per step; higher values divide it for more clicks per gesture. */
export const MIN_WHEEL_SPEED = 1
export const MAX_WHEEL_SPEED = 12

/**
 * How far one click scrolls is the remote desktop's business, not ours, and it varies a lot — a
 * Linux toolkit moves about a line, some servers less. Three clicks per 50px is parity with a
 * local scroll at a line per click; five leaves headroom for the stingier remotes, which is the
 * side worth erring on because too-fast is obvious and adjustable while too-slow reads as broken.
 */
export const DEFAULT_WHEEL_SPEED = 5

/** The subset of `WheelEvent` the pump reads. */
export interface WheelDelta {
  deltaX: number
  deltaY: number
  deltaMode: number
}

/** One step-sized wheel delta, ready to be replayed as its own event. */
export interface WheelStep {
  deltaX: number
  deltaY: number
}

export interface WheelPumpOptions {
  /** Called once per owed step, paced across frames. */
  emit(step: WheelStep): void
  /** Frame scheduler; defaults to `requestAnimationFrame`. Injected so tests can drive it. */
  schedule?: (run: () => void) => void
  speed?: number
}

export interface WheelPump {
  /** Feed a wheel event in. Leading steps go out immediately, the rest ride the paced loop. */
  push(event: WheelDelta): void
  setSpeed(speed: number): void
  /** Drop the backlog, for when the session or control mode changes underneath us. */
  reset(): void
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return DEFAULT_WHEEL_SPEED
  return Math.min(MAX_WHEEL_SPEED, Math.max(MIN_WHEEL_SPEED, speed))
}

function pixels(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta)) return 0
  return deltaMode === 0 ? delta : delta * WHEEL_LINE_HEIGHT
}

/** Reversing direction abandons the old backlog so the turnaround is not swallowed by it. */
function accumulate(pending: number, delta: number): number {
  if (delta === 0) return pending
  return Math.sign(pending) === -Math.sign(delta) ? delta : pending + delta
}

export function createWheelPump(options: WheelPumpOptions): WheelPump {
  const schedule =
    options.schedule ??
    ((run: () => void): void => {
      requestAnimationFrame(run)
    })
  let speed = clampSpeed(options.speed ?? DEFAULT_WHEEL_SPEED)
  let pendingX = 0
  let pendingY = 0
  let scheduled = false

  const pixelsPerStep = (): number => WHEEL_STEP / speed

  function clampPending(pending: number): number {
    return Math.min(MAX_PENDING_PIXELS, Math.max(-MAX_PENDING_PIXELS, pending))
  }

  function owes(pending: number): boolean {
    return Math.abs(pending) >= pixelsPerStep() - STEP_EPSILON
  }

  function spend(pending: number): number {
    const remainder = pending - Math.sign(pending) * pixelsPerStep()
    return Math.abs(remainder) < STEP_EPSILON ? 0 : remainder
  }

  function owesStep(): boolean {
    return owes(pendingX) || owes(pendingY)
  }

  function drain(): void {
    let budget = Math.max(1, Math.round(FRAME_PIXEL_BUDGET / pixelsPerStep()))
    // Round-robin, so a continuous vertical scroll cannot starve the horizontal axis.
    while (budget > 0) {
      const spent = budget
      if (budget > 0 && owes(pendingY)) {
        const direction = Math.sign(pendingY)
        pendingY = spend(pendingY)
        options.emit({ deltaX: 0, deltaY: direction * WHEEL_STEP })
        budget--
      }
      if (budget > 0 && owes(pendingX)) {
        const direction = Math.sign(pendingX)
        pendingX = spend(pendingX)
        options.emit({ deltaX: direction * WHEEL_STEP, deltaY: 0 })
        budget--
      }
      if (budget === spent) break
    }
  }

  function pump(): void {
    drain()
    scheduled = owesStep()
    if (scheduled) schedule(pump)
  }

  return {
    push(event: WheelDelta): void {
      pendingX = clampPending(accumulate(pendingX, pixels(event.deltaX, event.deltaMode)))
      pendingY = clampPending(accumulate(pendingY, pixels(event.deltaY, event.deltaMode)))
      // Drain inside the gesture's own event so scrolling starts without a frame of latency.
      // Once the loop is running it owns the backlog and this event only tops it up.
      if (!scheduled) pump()
    },
    setSpeed(next: number): void {
      speed = clampSpeed(next)
    },
    reset(): void {
      pendingX = 0
      pendingY = 0
    },
  }
}
