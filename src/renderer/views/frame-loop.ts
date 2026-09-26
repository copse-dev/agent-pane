/**
 * A per-animation-frame loop for the conversation's own motion (the stream
 * follow's glide). Streamed text itself is paced by
 * `@copse/streaming-markdown/smoothing`.
 */

/**
 * A gap between frames longer than this means the window was hidden or the
 * renderer stalled; animating across it would only replay motion nobody saw.
 */
const MAX_FRAME_GAP_MS = 250

export interface FrameSource {
  now: () => number
  request: (callback: () => void) => number
  cancel: (handle: number) => void
  /** False when motion should be skipped: reduced motion, or a hidden window. */
  canAnimate: () => boolean
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const browserFrames: FrameSource = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => {
    cancelAnimationFrame(handle)
  },
  canAnimate: () => document.visibilityState !== 'hidden' && !prefersReducedMotion(),
}

export interface FrameLoop {
  /** Run `step` on upcoming frames until it returns false. No-op while running. */
  start: () => void
  stop: () => void
}

/**
 * Call `step(dtMs)` once per animation frame while it returns true.
 *
 * `step` receives `Infinity` when it must finish in one go rather than
 * animate, and the loop ends after that call whatever it returns: motion is
 * off ({@link FrameSource.canAnimate}), the frame gap was too long to animate
 * across, or the frame source ran the callback synchronously inside `request`
 * — a source like that cannot pace anything, and re-requesting from inside it
 * would recurse without bound.
 */
export function createFrameLoop(
  step: (dtMs: number) => boolean,
  frames: FrameSource = browserFrames,
): FrameLoop {
  let handle: number | null = null
  let lastTick = 0
  let requesting = false
  let framesRun = 0

  const frame = (): void => {
    framesRun++
    handle = null
    const now = frames.now()
    const gap = now - lastTick
    lastTick = now
    const dt = requesting || gap > MAX_FRAME_GAP_MS || !frames.canAnimate() ? Infinity : gap
    if (step(dt) && dt !== Infinity) schedule()
  }

  const schedule = (): void => {
    const before = framesRun
    requesting = true
    const requested = frames.request(frame)
    requesting = false
    // A synchronous source has already run (and finished) the frame.
    if (framesRun === before) handle = requested
  }

  return {
    start: (): void => {
      if (handle !== null) return
      lastTick = frames.now()
      if (frames.canAnimate()) schedule()
      else step(Infinity)
    },
    stop: (): void => {
      if (handle !== null) frames.cancel(handle)
      handle = null
    },
  }
}
