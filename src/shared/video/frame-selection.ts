/**
 * Deciding which sampled frames are worth showing the model.
 *
 * The decoder samples a video on a fixed grid and, for each sample, reduces the
 * frame to a coarse grid of mean cell colours — its *signature*. Everything in
 * this module works on signatures alone, so the selection policy is pure and
 * unit-testable without decoding anything.
 *
 * Why a cell grid rather than a whole-frame average or a perceptual hash: screen
 * recordings change *locally*. A dialog opening, a line of output appearing, a
 * tab switching — each repaints a small fraction of the screen while the frame
 * average barely moves, so a global metric would score a meaningful change as
 * identical. Counting how many cells moved catches localized change and ignores
 * codec noise (a cell has to move by `CELL_DELTA` to count at all).
 */

/** Signature grid. 16:9-ish, chosen so one cell ≈ a short run of text. */
export const SIGNATURE_COLUMNS = 32
export const SIGNATURE_ROWS = 18
export const SIGNATURE_CELLS = SIGNATURE_COLUMNS * SIGNATURE_ROWS

/**
 * Channels stored per cell (R, G, B).
 *
 * Luma alone would be half the size and is tempting for a screen recording,
 * where most change is text appearing on a background. It is also wrong in a
 * case people record video specifically to show: a status turning from red to
 * green, a diff line flipping from removed to added, a chart re-colouring. Those
 * are near-identical in brightness and would score as no change at all. Keeping
 * the channels separate costs ~1.7 kB per sampled frame and makes hue changes
 * visible to the distance function.
 */
export const SIGNATURE_CHANNELS = 3

/** Total entries in a signature: one RGB triple per cell. */
export const SIGNATURE_LENGTH = SIGNATURE_CELLS * SIGNATURE_CHANNELS

/**
 * How far a cell's mean colour (0–255 per channel) must move on its
 * furthest-moving channel before the cell counts as changed. Below this is
 * compression noise and sub-pixel scroll jitter; a real repaint moves cells much
 * further.
 */
export const CELL_DELTA = 12

export type FrameSensitivity = 'low' | 'normal' | 'high'

/**
 * Fraction of the signature grid that must change, at a ≥1s gap, for two frames
 * to count as distinct. `normal` ≈ 12 of 576 cells — about a line of text
 * appearing across the window, and comfortably above cursor blink or a caret.
 */
const BASE_THRESHOLD: Record<FrameSensitivity, number> = {
  high: 0.008,
  normal: 0.02,
  low: 0.05,
}

/**
 * Extra strictness applied as the gap between two frames shrinks below a second.
 *
 * Two frames a second or more apart are cheap to justify: whatever changed had
 * time to matter. Two frames 100ms apart are almost always the same moment
 * caught mid-animation — a fade, a scroll, a menu sliding open — and returning
 * both spends a full image's worth of tokens on a duplicate. So the closer
 * together two candidates are, the *more* they have to differ to both survive:
 * the threshold scales up to `1 + SUBSECOND_STRICTNESS` (3×) as the gap
 * approaches zero, and relaxes to the base at `SUBSECOND_WINDOW_SECONDS`.
 */
export const SUBSECOND_WINDOW_SECONDS = 1
export const SUBSECOND_STRICTNESS = 2

/**
 * Distance between two frame signatures: the fraction of grid cells whose mean
 * colour moved by more than {@link CELL_DELTA} on any channel. 0 = identical at
 * grid resolution, 1 = every cell repainted.
 */
export function frameDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const cells = Math.floor(Math.min(a.length, b.length) / SIGNATURE_CHANNELS)
  if (cells === 0) return 0
  let changed = 0
  for (let cell = 0; cell < cells; cell++) {
    const base = cell * SIGNATURE_CHANNELS
    for (let channel = 0; channel < SIGNATURE_CHANNELS; channel++) {
      const i = base + channel
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > CELL_DELTA) {
        changed += 1
        break
      }
    }
  }
  return changed / cells
}

/**
 * The distance two frames `gapSeconds` apart must reach to both be kept.
 * See {@link SUBSECOND_STRICTNESS} for why closeness in time raises the bar.
 */
export function distanceThreshold(gapSeconds: number, sensitivity: FrameSensitivity): number {
  const base = BASE_THRESHOLD[sensitivity]
  const gap = Math.max(0, Math.min(gapSeconds, SUBSECOND_WINDOW_SECONDS))
  const closeness = 1 - gap / SUBSECOND_WINDOW_SECONDS
  return base * (1 + SUBSECOND_STRICTNESS * closeness)
}

export interface FrameCandidate {
  /** Position in the source video, in seconds. */
  time: number
  /** Cell-mean RGB grid, {@link SIGNATURE_LENGTH} entries. */
  signature: ArrayLike<number>
}

export interface SelectedFrame {
  time: number
  /**
   * Distance from the previously kept frame — how much of the screen changed to
   * earn this frame a place. The first frame is 1 (it establishes the baseline);
   * used to decide what to drop when `maxFrames` bites.
   */
  change: number
}

export interface SelectFramesOptions {
  sensitivity?: FrameSensitivity
  /** Hard cap on returned frames. The lowest-change frames are dropped first. */
  maxFrames?: number
}

/**
 * Greedily keep frames that differ enough from the last one kept.
 *
 * Comparing against the last *kept* frame rather than the previous *candidate*
 * is what makes a slow change (a progress bar creeping, a page fading in)
 * eventually register instead of being lost to a series of individually
 * sub-threshold steps. It is also what makes a genuinely still video collapse to
 * exactly one frame: nothing ever clears the bar against the opening frame.
 */
export function selectDistinctFrames(
  candidates: readonly FrameCandidate[],
  options: SelectFramesOptions = {},
): SelectedFrame[] {
  const sensitivity = options.sensitivity ?? 'normal'
  const first = candidates[0]
  if (!first) return []

  const kept: SelectedFrame[] = [{ time: first.time, change: 1 }]
  let anchor = first
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate) continue
    const distance = frameDistance(anchor.signature, candidate.signature)
    if (distance >= distanceThreshold(candidate.time - anchor.time, sensitivity)) {
      kept.push({ time: candidate.time, change: distance })
      anchor = candidate
    }
  }

  return capFrames(kept, options.maxFrames)
}

/**
 * Trim a selection to `maxFrames` by dropping the least-changed frames first.
 *
 * Raising the threshold until the count fits would be the other option, but it
 * biases toward the start of the video (an early flurry of change eats the
 * budget). Ranking by change keeps the most visually significant moments
 * wherever they fall, and the survivors are re-sorted into time order because
 * the model reads them as a sequence.
 */
function capFrames(frames: SelectedFrame[], maxFrames: number | undefined): SelectedFrame[] {
  if (maxFrames === undefined || maxFrames <= 0 || frames.length <= maxFrames) return frames
  // The opening frame is the baseline every later frame is a delta against, so
  // it is never a drop candidate regardless of its (synthetic) change score.
  const [opening, ...rest] = frames
  if (!opening) return frames
  const survivors = [...rest]
    .sort((a, b) => b.change - a.change || a.time - b.time)
    .slice(0, maxFrames - 1)
  return [opening, ...survivors].sort((a, b) => a.time - b.time)
}

/** Sample positions, in seconds, for a `[start, end]` window. */
export function sampleTimes(
  start: number,
  end: number,
  interval: number,
  maxSamples: number,
): number[] {
  const span = Math.max(0, end - start)
  const step = Math.max(interval, span / Math.max(1, maxSamples - 1))
  const times: number[] = []
  for (let t = start; t <= end + 1e-6 && times.length < maxSamples; t += step) {
    times.push(Number(Math.min(t, end).toFixed(3)))
    if (step <= 0) break
  }
  if (times.length === 0) times.push(start)
  return times
}
