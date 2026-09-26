/**
 * Paces streamed assistant prose onto the screen at a steady cadence.
 *
 * Providers deliver text in bursts: a few characters every 30–100ms, often
 * clumped further by IPC. Painting each burst as it lands makes the answer
 * lurch — nothing moves for several frames, then a word or three appears at
 * once. The pacer decouples the two: the store keeps the real text, and the
 * view reveals a growing prefix of it every animation frame at a velocity that
 * tracks the arrival rate.
 *
 * The velocity is low-pass filtered toward `backlog / LAG_MS`, so a steady
 * stream reveals at a steady rate a little behind the transport, a burst
 * speeds the reveal up over a few frames instead of in one jump, and the lag
 * never grows without bound however fast the model is. Every painted value is
 * a prefix of the text (see {@link revealBoundary} for where it may end), so it
 * composes with the incremental markdown renderer's pending states.
 */

/** Target distance, in time, between the arrived text and the revealed text. */
const LAG_MS = 120
/** Once the stream has ended, drain what is left over this much shorter lag. */
const DRAIN_LAG_MS = 60
/** Time constant of the velocity filter: how quickly the reveal changes speed. */
const VELOCITY_SMOOTHING_MS = 180
/** Floor so the last few characters of a pause never crawl out one at a time. */
const MIN_CHARS_PER_MS = 0.06
/** How far {@link revealBoundary} may push a cut past markdown punctuation. */
const MAX_BOUNDARY_EXTENSION = 32
/**
 * A gap between frames longer than this means the window was hidden or the
 * renderer stalled; catching up by animating the whole backlog would only
 * replay text the reader could have been reading already.
 */
const MAX_FRAME_GAP_MS = 250

/** The clock and frame scheduler a {@link FrameLoop} runs on. */
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

// Characters that open, close, or introduce markdown syntax. A reveal that
// stops right after one of them shows the raw character for a frame before
// the renderer can tell what it becomes: a closing fence's first two
// backticks, a table separator's pipes, a `1.` before its list item, the
// brackets of `[text]` before `(url)` arrives.
const SYNTAX_CHARS = new Set('`*_~[]()|#>!-+=.:<\\0123456789')

/**
 * Whitespace is undecided too: a trailing newline or indent can briefly open
 * an empty line, and `## `, `- `, `> ` are only settled by what follows them.
 */
function endsUndecided(text: string, end: number): boolean {
  const last = text[end - 1]
  return last !== undefined && (SYNTAX_CHARS.has(last) || /\s/.test(last))
}

/**
 * Where a reveal of `count` characters may end: never splitting a surrogate
 * pair, and only right after a word character — the cut moves forward past
 * markdown punctuation and whitespace (see SYNTAX_CHARS), up to a small bound.
 */
export function revealBoundary(text: string, count: number): number {
  if (count <= 0) return 0
  if (count >= text.length) return text.length
  let end = count
  const limit = Math.min(text.length, count + MAX_BOUNDARY_EXTENSION)
  while (end < limit && endsUndecided(text, end)) end++
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end++
  return end
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export interface StreamPacer {
  /** Set the text streamed so far; the reveal walks toward it. Cancels a pending finish. */
  push: (text: string) => void
  /**
   * The stream ended. Reveal what is left promptly, then call `settle` once —
   * synchronously when nothing is left to reveal.
   */
  finish: (settle: () => void) => void
}

/**
 * Pace the text pushed into `paint`. `initial` is already on screen — a
 * message rebuilt mid-stream must not replay what the reader has seen — so
 * pacing starts from its end.
 */
export function createStreamPacer(
  paint: (text: string) => void,
  initial = '',
  frames: FrameSource = browserFrames,
): StreamPacer {
  let target = initial
  let painted = initial
  // Revealed length as a float, so sub-character frame budgets accumulate.
  let revealed = initial.length
  let velocity = 0
  let settle: (() => void) | null = null

  const settleNow = (): void => {
    const done = settle
    settle = null
    done?.()
  }

  const step = (dt: number): boolean => {
    const backlog = target.length - revealed
    if (dt === Infinity || backlog <= 0) {
      revealed = target.length
    } else {
      const desired = Math.max(backlog / (settle ? DRAIN_LAG_MS : LAG_MS), MIN_CHARS_PER_MS)
      velocity += (desired - velocity) * (1 - Math.exp(-dt / VELOCITY_SMOOTHING_MS))
      // Draining must not wait for the filter to ramp up.
      if (settle) velocity = Math.max(velocity, desired)
      revealed = Math.min(target.length, revealed + velocity * dt)
    }
    const end = revealBoundary(target, Math.floor(revealed))
    revealed = Math.max(revealed, end)
    const next = target.slice(0, end)
    if (next !== painted) {
      painted = next
      paint(next)
    }
    if (end < target.length) return true
    settleNow()
    return false
  }

  const loop = createFrameLoop(step, frames)

  return {
    push: (text: string): void => {
      // More text means the stream is live again; a pending finish is void.
      settle = null
      if (!text.startsWith(painted)) {
        // Only a correction rewrites text already shown; resume from what
        // still agrees rather than replay the whole message.
        revealed = Math.min(revealed, commonPrefixLength(painted, text))
      }
      target = text
      loop.start()
    },
    finish: (onSettled: () => void): void => {
      settle = onSettled
      if (painted === target) {
        loop.stop()
        settleNow()
        return
      }
      loop.start()
    },
  }
}
