import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CELL_DELTA,
  SIGNATURE_CHANNELS,
  SIGNATURE_TARGET_CELLS,
  SUBSECOND_STRICTNESS,
  SUBSECOND_WINDOW_SECONDS,
  distanceThreshold,
  frameDistance,
  peakChange,
  sampleTimes,
  selectDistinctFrames,
  signatureGridFor,
  signatureLength,
  type FrameCandidate,
} from './frame-selection.ts'

/** A 16:9 grid, the shape most of these fixtures assume. */
const GRID = signatureGridFor(1920, 1080)
const CELLS = GRID.cells
const LENGTH = signatureLength(GRID)

/** A signature whose first `changedCells` cells are repainted brighter. */
function signature(changedCells: number): Uint8Array {
  const sig = new Uint8Array(LENGTH).fill(40)
  sig.fill(40 + CELL_DELTA * 2, 0, changedCells * SIGNATURE_CHANNELS)
  return sig
}

function candidate(time: number, changedCells: number): FrameCandidate {
  return { time, signature: signature(changedCells) }
}

describe('signatureGridFor', () => {
  it('keeps cells near-square for a landscape frame', () => {
    const grid = signatureGridFor(1920, 1080)
    const cellWidth = 1920 / grid.columns
    const cellHeight = 1080 / grid.rows
    assert.ok(
      Math.abs(cellWidth / cellHeight - 1) < 0.15,
      `cells are ${String(cellWidth)}x${String(cellHeight)}`,
    )
  })

  it('keeps cells near-square for a portrait frame', () => {
    // The bug this replaced: a fixed 32x18 grid on a 2296x3916 phone capture
    // gave 40x121px cells, so a panel collapsing in a short horizontal strip was
    // averaged across three times its own height and never cleared CELL_DELTA.
    const grid = signatureGridFor(2296, 3916)
    const cellWidth = 2296 / grid.columns
    const cellHeight = 3916 / grid.rows
    assert.ok(grid.rows > grid.columns, 'a portrait frame needs a taller grid than it is wide')
    assert.ok(
      Math.abs(cellWidth / cellHeight - 1) < 0.15,
      `cells are ${String(cellWidth)}x${String(cellHeight)}`,
    )
  })

  it('stays near the target cell count whatever the shape', () => {
    for (const [width, height] of [
      [1920, 1080],
      [2296, 3916],
      [1280, 1280],
      [3440, 1440],
    ] as const) {
      const grid = signatureGridFor(width, height)
      assert.ok(
        grid.cells > SIGNATURE_TARGET_CELLS * 0.7 && grid.cells < SIGNATURE_TARGET_CELLS * 1.3,
        `${String(width)}x${String(height)} produced ${String(grid.cells)} cells`,
      )
      assert.equal(grid.cells, grid.columns * grid.rows)
      assert.equal(signatureLength(grid), grid.cells * SIGNATURE_CHANNELS)
    }
  })

  it('falls back to a landscape grid for a frame with no dimensions', () => {
    const grid = signatureGridFor(0, 0)
    assert.deepEqual(grid, signatureGridFor(1920, 1080))
  })
})

describe('frameDistance', () => {
  it('is 0 for identical signatures', () => {
    assert.equal(frameDistance(signature(0), signature(0)), 0)
  })

  it('ignores movement at or below the noise floor', () => {
    const a = new Uint8Array(LENGTH).fill(100)
    const b = new Uint8Array(LENGTH).fill(100 + CELL_DELTA)
    assert.equal(frameDistance(a, b), 0)
  })

  it('sees a hue change that leaves brightness untouched', () => {
    // A status flipping red -> green is near-identical in luma. Recording that
    // moment is exactly why someone shares a screen capture, so the distance
    // function must not be blind to it.
    const red = new Uint8Array(LENGTH)
    const green = new Uint8Array(LENGTH)
    for (let cell = 0; cell < CELLS; cell++) {
      const base = cell * SIGNATURE_CHANNELS
      red[base] = 128
      red[base + 1] = 48
      red[base + 2] = 16
      green[base] = 16
      green[base + 1] = 96
      green[base + 2] = 64
    }
    assert.equal(frameDistance(red, green), 1)
  })

  it('flags a cell when any single channel moves', () => {
    const a = new Uint8Array(LENGTH).fill(40)
    const b = new Uint8Array(LENGTH).fill(40)
    // Only the blue channel of the first cell.
    b[2] = 40 + CELL_DELTA * 2
    assert.equal(frameDistance(a, b), 1 / CELLS)
  })

  it('reports the fraction of repainted cells', () => {
    const changed = CELLS / 4
    assert.equal(frameDistance(signature(0), signature(changed)), 0.25)
  })

  it('is 1 when every cell is repainted', () => {
    assert.equal(frameDistance(signature(0), signature(CELLS)), 1)
  })

  it('compares over the cells the two signatures share', () => {
    // Grids differ between calls (a portrait clip and a landscape one), so the
    // metric must stay defined rather than reading past the shorter signature.
    const wide = signature(0)
    const tall = new Uint8Array(signatureLength(signatureGridFor(1080, 1920))).fill(40)
    assert.equal(frameDistance(wide, tall), 0)
  })
})

describe('distanceThreshold', () => {
  it('relaxes to the base threshold once frames are a second apart', () => {
    const base = distanceThreshold(SUBSECOND_WINDOW_SECONDS, 'normal')
    assert.equal(distanceThreshold(5, 'normal'), base)
    assert.equal(distanceThreshold(60, 'normal'), base)
  })

  it('tightens as the gap shrinks below a second', () => {
    const base = distanceThreshold(1, 'normal')
    assert.ok(distanceThreshold(0.5, 'normal') > base)
    assert.ok(distanceThreshold(0.1, 'normal') > distanceThreshold(0.5, 'normal'))
  })

  it('reaches the full strictness multiplier at a zero gap', () => {
    const base = distanceThreshold(1, 'normal')
    const closest = distanceThreshold(0, 'normal')
    assert.ok(Math.abs(closest - base * (1 + SUBSECOND_STRICTNESS)) < 1e-9)
  })

  it('orders the sensitivity presets from most to fewest frames', () => {
    assert.ok(distanceThreshold(1, 'high') < distanceThreshold(1, 'normal'))
    assert.ok(distanceThreshold(1, 'normal') < distanceThreshold(1, 'low'))
  })
})

describe('selectDistinctFrames', () => {
  it('returns nothing for no candidates', () => {
    assert.deepEqual(selectDistinctFrames([]), [])
  })

  it('collapses a completely still video to a single frame', () => {
    const still = Array.from({ length: 40 }, (_, i) => candidate(i * 0.5, 0))
    const selected = selectDistinctFrames(still)
    assert.equal(selected.length, 1)
    assert.equal(selected[0]?.time, 0)
  })

  it('keeps a frame once a meaningful region repaints', () => {
    // context: 0 isolates the threshold policy; the bracketing samples that
    // normally accompany a change have their own tests below.
    const selected = selectDistinctFrames(
      [candidate(0, 0), candidate(1, 0), candidate(2, CELLS / 2), candidate(3, CELLS / 2)],
      { context: 0 },
    )
    assert.deepEqual(
      selected.map((f) => f.time),
      [0, 2],
    )
  })

  it('accumulates a slow change against the last kept frame', () => {
    // Each step alone is below threshold; measured against the kept anchor the
    // drift eventually clears it, so a gradual fade is not lost entirely.
    const creeping = Array.from({ length: 30 }, (_, i) => candidate(i, i))
    const selected = selectDistinctFrames(creeping, { context: 0 })
    assert.ok(selected.length > 1, 'a slow change should still produce a second frame')
    assert.ok(selected.length < creeping.length, 'but not one frame per step')
  })

  it('demands more change from frames sampled less than a second apart', () => {
    // The same repaint, sampled at 4fps and at 2s intervals. The tight sampling
    // has to clear a 3x-ish bar, so the burst does not turn into a frame each.
    const changed = Math.round(CELLS * 0.03)
    const burst = [candidate(0, 0), candidate(0.25, changed), candidate(0.5, changed * 2)]
    const spread = [candidate(0, 0), candidate(2, changed), candidate(4, changed * 2)]
    const changes = (c: FrameCandidate[]): number =>
      selectDistinctFrames(c, { context: 0 }).filter((f) => f.role === 'change').length
    assert.ok(changes(burst) < changes(spread))
  })

  it('honours maxFrames by dropping the least-changed frames', () => {
    const candidates = [
      candidate(0, 0),
      candidate(2, Math.round(CELLS * 0.05)),
      candidate(4, CELLS),
      // Unchanged from t=4, so it never earns a place of its own.
      candidate(6, CELLS),
    ]
    const selected = selectDistinctFrames(candidates, { maxFrames: 2 })
    assert.equal(selected.length, 2)
    assert.equal(selected[0]?.time, 0, 'the opening frame is always the baseline')
    assert.equal(selected[1]?.time, 4, 'the biggest repaint survives the cap')
  })

  it('returns capped frames in time order', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => candidate(i, i % 2 === 0 ? CELLS : 0))
    const selected = selectDistinctFrames(candidates, { maxFrames: 4 })
    assert.equal(selected.length, 4)
    const times = selected.map((f) => f.time)
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
    )
  })

  it('returns fewer frames at low sensitivity than at high', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate(i, Math.round(CELLS * 0.03) * (i % 2)),
    )
    const high = selectDistinctFrames(candidates, { sensitivity: 'high', context: 0 })
    const low = selectDistinctFrames(candidates, { sensitivity: 'low', context: 0 })
    assert.ok(low.length <= high.length)
  })
})

describe('context frames around a change', () => {
  it('brackets a change with the samples either side of it', () => {
    const selected = selectDistinctFrames([
      candidate(0, 0),
      candidate(1, 0),
      candidate(2, CELLS / 2),
      candidate(3, CELLS / 2),
    ])
    assert.deepEqual(
      selected.map((f) => [f.time, f.role]),
      [
        [0, 'opening'],
        [1, 'before'],
        [2, 'change'],
        [3, 'after'],
      ],
    )
  })

  it('returns three frames for a flicker, not one', () => {
    // The case this exists for: content appears for a single sample and goes
    // again. One frame from the middle of that is unreadable — the model cannot
    // tell what appeared from what vanished without the states either side.
    const flicker = [
      candidate(0, 0),
      candidate(1, 0),
      candidate(2, Math.round(CELLS * 0.3)),
      candidate(3, 0),
      candidate(4, 0),
    ]
    const selected = selectDistinctFrames(flicker)
    assert.ok(
      selected.length >= 3,
      `a flicker needs before/change/after, got ${String(selected.length)}`,
    )
    const roles = new Set(selected.map((f) => f.role))
    assert.ok(roles.has('change'))
    assert.ok(roles.has('before') || roles.has('opening'))
    assert.ok(roles.has('after'))
  })

  it('scores each frame against the one before it in the result', () => {
    // Not against the selection anchor: the anchor is invisible to whoever
    // reads the manifest, so a percentage measured from it describes a
    // comparison the model cannot make.
    const selected = selectDistinctFrames([
      candidate(0, 0),
      candidate(1, 0),
      candidate(2, CELLS / 2),
      candidate(3, CELLS / 2),
    ])
    assert.equal(selected[1]?.change, 0, 'the before frame is unchanged from the opening')
    assert.equal(selected[2]?.change, 0.5, 'the change frame moved half the grid')
    assert.equal(selected[3]?.change, 0, 'the after frame is unchanged from the change')
  })

  it('keeps a change on its own rather than dropping it when context will not fit', () => {
    const candidates = [
      candidate(0, 0),
      candidate(1, 0),
      candidate(2, Math.round(CELLS * 0.3)),
      candidate(3, 0),
    ]
    const selected = selectDistinctFrames(candidates, { maxFrames: 2 })
    assert.equal(selected.length, 2)
    assert.deepEqual(
      selected.map((f) => f.role),
      ['opening', 'change'],
    )
  })

  it('returns at least two frames whenever anything moved at all', () => {
    // A sub-threshold change used to come back as a single frame, which reads
    // as "nothing happened" and leaves nothing to compare it against.
    const subtle = [candidate(0, 0), candidate(1, 0), candidate(2, 2), candidate(3, 2)]
    const selected = selectDistinctFrames(subtle)
    assert.ok(selected.length >= 2)
    assert.ok(
      selected.some((f) => f.role === 'peak'),
      'the largest change is marked as under the bar rather than confirmed distinct',
    )
  })

  it('still collapses a genuinely still recording to one frame', () => {
    // The floor is "at least two once something moved", not "always two" — a
    // static screen has nothing to compare.
    const still = Array.from({ length: 20 }, (_, i) => candidate(i * 0.5, 0))
    assert.equal(selectDistinctFrames(still).length, 1)
  })
})

describe('peakChange', () => {
  it('is null without a pair to compare', () => {
    assert.equal(peakChange([]), null)
    assert.equal(peakChange([candidate(0, 0)]), null)
  })

  it('is 0 for a still video', () => {
    const still = Array.from({ length: 10 }, (_, i) => candidate(i * 0.5, 0))
    assert.equal(peakChange(still)?.change, 0)
  })

  it('reports the largest consecutive change and when it happened', () => {
    const peak = peakChange([
      candidate(0, 0),
      candidate(1, Math.round(CELLS * 0.1)),
      candidate(2, Math.round(CELLS * 0.1)),
      candidate(3, 0),
    ])
    assert.ok(peak)
    assert.equal(peak.time, 1)
    assert.ok(Math.abs(peak.change - 0.1) < 0.01)
  })

  it('sees change that fell under the selection bar', () => {
    // The reason it exists: no frame cleared the threshold, yet something moved
    // and was judged too small. That is what the `peak` role reports.
    const candidates = [candidate(0, 0), candidate(0.1, 2), candidate(0.2, 0)]
    const selected = selectDistinctFrames(candidates, { context: 0 })
    assert.ok(selected.every((f) => f.role !== 'change'))
    const peak = peakChange(candidates)
    assert.ok(peak)
    assert.ok(peak.change > 0)
  })
})

describe('sampleTimes', () => {
  it('walks the window at the requested interval', () => {
    assert.deepEqual(sampleTimes(0, 2, 0.5, 100), [0, 0.5, 1, 1.5, 2])
  })

  it('starts and ends on the window bounds', () => {
    const times = sampleTimes(10, 12, 0.5, 100)
    assert.equal(times[0], 10)
    assert.equal(times.at(-1), 12)
  })

  it('stretches the interval rather than exceeding maxSamples', () => {
    const times = sampleTimes(0, 600, 0.5, 20)
    assert.ok(times.length <= 20)
    assert.equal(times[0], 0)
    assert.equal(times.at(-1), 600)
  })

  it('yields a single sample for a zero-length window', () => {
    assert.deepEqual(sampleTimes(4, 4, 0.5, 100), [4])
  })

  it('names positions in the source video, not offsets into the window', () => {
    // Frame files are named from these values, so a call starting at 10s must
    // produce frame-00-00-10.000, not frame-00-00-00.000.
    assert.deepEqual(sampleTimes(10, 11, 0.5, 100), [10, 10.5, 11])
  })
})

describe('high sensitivity and short-lived events', () => {
  it('drops the sub-second penalty at high sensitivity', () => {
    // A caller asking for high sensitivity — usually after narrowing to a
    // couple of seconds — wants everything that changed, including the brief
    // event they zoomed in to find.
    assert.equal(distanceThreshold(0, 'high'), distanceThreshold(5, 'high'))
    assert.ok(distanceThreshold(0, 'normal') > distanceThreshold(5, 'normal'))
  })

  it('keeps a one-sample flicker that normal sensitivity would hide', () => {
    // Content vanishes for a single 33ms sample and comes back.
    const gone = Math.round(CELLS * 0.04)
    const candidates = [
      candidate(0, 0),
      candidate(0.033, gone),
      candidate(0.066, 0),
      candidate(0.099, 0),
    ]
    const high = selectDistinctFrames(candidates, { sensitivity: 'high' })
    assert.ok(
      high.some((f) => f.time === 0.033),
      'the frame where the content disappeared must survive at high sensitivity',
    )
  })
})
