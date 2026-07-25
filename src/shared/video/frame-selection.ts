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

/**
 * Cells in a signature, however the frame is shaped. ~576 keeps one cell at
 * roughly a short run of text on a typical capture.
 */
export const SIGNATURE_TARGET_CELLS = 576

export interface SignatureGrid {
  columns: number
  rows: number
  cells: number
}

/**
 * Split a frame into ~{@link SIGNATURE_TARGET_CELLS} near-square cells.
 *
 * The grid used to be a fixed 32x18 regardless of the frame, which is only
 * right for 16:9. On a portrait screen recording (2296x3916 — a tall window, a
 * phone, a stacked layout) that made each cell 40x121px: a 3:1 vertical smear.
 * A panel collapsing inside a short horizontal strip was averaged across three
 * times its own height, so the cell mean never moved past {@link CELL_DELTA}
 * and the change was invisible at every sensitivity. Deriving the split from
 * the aspect ratio keeps cells square, so a change registers in proportion to
 * the area it actually covers.
 */
export function signatureGridFor(width: number, height: number): SignatureGrid {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9
  const columns = Math.min(64, Math.max(8, Math.round(Math.sqrt(SIGNATURE_TARGET_CELLS * aspect))))
  const rows = Math.min(64, Math.max(8, Math.round(SIGNATURE_TARGET_CELLS / columns)))
  return { columns, rows, cells: columns * rows }
}

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

/** Entries in a signature for a given grid: one RGB triple per cell. */
export function signatureLength(grid: SignatureGrid): number {
  return grid.cells * SIGNATURE_CHANNELS
}

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
  return base * (1 + subsecondStrictness(sensitivity) * closeness)
}

export interface FrameCandidate {
  /** Position in the source video, in seconds. */
  time: number
  /** Cell-mean RGB grid; the cell count comes from the frame's aspect ratio. */
  signature: ArrayLike<number>
}

/**
 * Why a frame is in the result. The model reads a sequence, and "this is the
 * state just before it changed" is a different claim from "this is what
 * changed" — collapsing them loses the only thing that makes a transient
 * change readable.
 */
export type FrameRole =
  /** The first sample: the baseline everything else is a change against. */
  | 'opening'
  /** Cleared the distinctness bar against the last kept frame. */
  | 'change'
  /** A neighbouring sample kept to show the state before a change. */
  | 'before'
  /** A neighbouring sample kept to show the state after a change. */
  | 'after'
  /** Nothing cleared the bar; this is the largest change in the range anyway. */
  | 'peak'

export interface SelectedFrame {
  time: number
  /**
   * Distance from the frame before it *in this result* — so the frames read as
   * a sequence rather than as deltas against an anchor the model cannot see.
   * The opening frame is 1 (it establishes the baseline).
   */
  change: number
  role: FrameRole
}

export interface SelectFramesOptions {
  sensitivity?: FrameSensitivity
  /** Hard cap on returned frames. Whole changes are dropped before partial ones. */
  maxFrames?: number
  /** Samples kept either side of a change; see {@link DEFAULT_CONTEXT_FRAMES}. */
  context?: number
}

/**
 * Samples kept either side of each change.
 *
 * A change returned as a single image is close to useless for the thing people
 * record videos to show. Handed one frame from the middle of a flicker, a model
 * cannot tell what appeared from what vanished — it has the state *during* the
 * event and nothing to compare it against, so it describes a screenshot instead
 * of a change. Keeping the sample before and the sample after makes the frame
 * self-describing: before, during, after. That is the minimum for reading a
 * flicker at all, which is why a range that contains any change returns at least
 * two frames and a transient one returns three.
 */
export const DEFAULT_CONTEXT_FRAMES = 1

/**
 * Whether the sub-second penalty applies at this sensitivity.
 *
 * At `high` it does not. The penalty exists to stop an animation becoming a
 * frame per tick during a broad survey, but a caller asking for high
 * sensitivity — usually after narrowing to a couple of seconds — is explicitly
 * asking to see everything that changed. Keeping the 3× bar there would hide
 * exactly the short-lived event they zoomed in to find.
 */
function subsecondStrictness(sensitivity: FrameSensitivity): number {
  return sensitivity === 'high' ? 0 : SUBSECOND_STRICTNESS
}

interface ChangeEvent {
  index: number
  change: number
}

/**
 * Samples that differ enough from the last one kept to count as a change.
 *
 * Comparing against the last *kept* frame rather than the previous *candidate*
 * is what makes a slow change (a progress bar creeping, a page fading in)
 * eventually register instead of being lost to a series of individually
 * sub-threshold steps. It is also what makes a genuinely still video produce no
 * events at all: nothing ever clears the bar against the opening frame.
 */
function changeEvents(
  candidates: readonly FrameCandidate[],
  sensitivity: FrameSensitivity,
): ChangeEvent[] {
  const events: ChangeEvent[] = []
  let anchor = candidates[0]
  if (!anchor) return events
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate) continue
    const distance = frameDistance(anchor.signature, candidate.signature)
    if (distance >= distanceThreshold(candidate.time - anchor.time, sensitivity)) {
      events.push({ index: i, change: distance })
      anchor = candidate
    }
  }
  return events
}

/** Neighbouring sample indices within `context` of `index`, nearest first. */
function neighbourhood(index: number, context: number, length: number): number[] {
  const indices: number[] = []
  for (let distance = 1; distance <= context; distance++) {
    if (index - distance >= 0) indices.push(index - distance)
    if (index + distance < length) indices.push(index + distance)
  }
  return indices
}

/**
 * Pick the frames to return: every change worth showing, each bracketed by the
 * samples either side of it.
 *
 * Changes are taken in order of size rather than in time order, so when
 * `maxFrames` bites it is the smallest changes that go rather than everything
 * after some cut-off point — an early flurry would otherwise eat the whole
 * budget and hide a bigger change later in the recording. A change whose
 * neighbours will not fit is still kept on its own: a change with no context
 * beats no change at all.
 */
export function selectDistinctFrames(
  candidates: readonly FrameCandidate[],
  options: SelectFramesOptions = {},
): SelectedFrame[] {
  const sensitivity = options.sensitivity ?? 'normal'
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT_FRAMES)
  const budget =
    options.maxFrames !== undefined && options.maxFrames > 0 ? options.maxFrames : Infinity
  if (!candidates[0]) return []

  const roles = new Map<number, FrameRole>([[0, 'opening']])
  const events = changeEvents(candidates, sensitivity)

  if (events.length === 0) {
    // Nothing cleared the bar. Returning the opening frame alone would say
    // "nothing happened", which is only true if the screen genuinely held
    // still — and leaves the model nothing to compare in the case where it
    // did not. So fall back to the largest change actually measured and the
    // sample before it: a pair the model can read, plus a `peak` role saying
    // it was judged too small rather than confirmed distinct.
    const peak = peakIndex(candidates)
    if (peak !== null && budget >= 2) {
      roles.set(peak, 'peak')
      if (peak - 1 > 0 && roles.size < budget) roles.set(peak - 1, 'before')
    }
    return emitFrames(candidates, roles)
  }

  for (const event of [...events].sort((a, b) => b.change - a.change || a.index - b.index)) {
    if (roles.size >= budget) break
    const fresh = neighbourhood(event.index, context, candidates.length).filter(
      (index) => !roles.has(index),
    )
    const cost = fresh.length + (roles.has(event.index) ? 0 : 1)
    if (roles.size + cost <= budget) {
      for (const index of fresh) roles.set(index, index < event.index ? 'before' : 'after')
      roles.set(event.index, 'change')
    } else if (!roles.has(event.index)) {
      roles.set(event.index, 'change')
    }
  }

  return emitFrames(candidates, roles)
}

/**
 * Turn chosen indices into time-ordered frames, scoring each against the frame
 * before it in the result rather than against the selection anchor — the anchor
 * is invisible to whoever reads the manifest, so a percentage measured from it
 * describes a comparison the model cannot make.
 */
function emitFrames(
  candidates: readonly FrameCandidate[],
  roles: ReadonlyMap<number, FrameRole>,
): SelectedFrame[] {
  const frames: SelectedFrame[] = []
  let previous: FrameCandidate | null = null
  for (const index of [...roles.keys()].sort((a, b) => a - b)) {
    const candidate = candidates[index]
    if (!candidate) continue
    frames.push({
      time: candidate.time,
      change: previous ? frameDistance(previous.signature, candidate.signature) : 1,
      role: roles.get(index) ?? 'change',
    })
    previous = candidate
  }
  return frames
}

/** Index of the sample that moved most from its predecessor; null if none did. */
function peakIndex(candidates: readonly FrameCandidate[]): number | null {
  let peak: number | null = null
  let largest = 0
  for (let i = 1; i < candidates.length; i++) {
    const previous = candidates[i - 1]
    const candidate = candidates[i]
    if (!previous || !candidate) continue
    const change = frameDistance(previous.signature, candidate.signature)
    if (change > largest) {
      largest = change
      peak = i
    }
  }
  return peak
}

/**
 * The biggest change between consecutive samples, whether or not it was
 * selected.
 *
 * Reported so a thin result is never a dead end. Without it the caller cannot
 * tell "the screen genuinely held still" from "something moved but it was under
 * the bar" — the second wants a lower sensitivity or a closer look, the first
 * wants neither, and the two are indistinguishable from a frame count.
 */
export function peakChange(
  candidates: readonly FrameCandidate[],
): { time: number; change: number } | null {
  let peak: { time: number; change: number } | null = null
  for (let i = 1; i < candidates.length; i++) {
    const previous = candidates[i - 1]
    const candidate = candidates[i]
    if (!previous || !candidate) continue
    const change = frameDistance(previous.signature, candidate.signature)
    if (!peak || change > peak.change) peak = { time: candidate.time, change }
  }
  return peak
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
