import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CELL_DELTA,
  SIGNATURE_CELLS,
  SIGNATURE_CHANNELS,
  SIGNATURE_LENGTH,
  SUBSECOND_STRICTNESS,
  SUBSECOND_WINDOW_SECONDS,
  distanceThreshold,
  frameDistance,
  sampleTimes,
  selectDistinctFrames,
  type FrameCandidate,
} from './frame-selection.ts'

/** A signature whose first `changedCells` cells are repainted brighter. */
function signature(changedCells: number): Uint8Array {
  const sig = new Uint8Array(SIGNATURE_LENGTH).fill(40)
  sig.fill(40 + CELL_DELTA * 2, 0, changedCells * SIGNATURE_CHANNELS)
  return sig
}

function candidate(time: number, changedCells: number): FrameCandidate {
  return { time, signature: signature(changedCells) }
}

describe('frameDistance', () => {
  it('is 0 for identical signatures', () => {
    assert.equal(frameDistance(signature(0), signature(0)), 0)
  })

  it('ignores movement at or below the noise floor', () => {
    const a = new Uint8Array(SIGNATURE_LENGTH).fill(100)
    const b = new Uint8Array(SIGNATURE_LENGTH).fill(100 + CELL_DELTA)
    assert.equal(frameDistance(a, b), 0)
  })

  it('sees a hue change that leaves brightness untouched', () => {
    // A status flipping red -> green is near-identical in luma. Recording that
    // moment is exactly why someone shares a screen capture, so the distance
    // function must not be blind to it.
    const red = new Uint8Array(SIGNATURE_LENGTH)
    const green = new Uint8Array(SIGNATURE_LENGTH)
    for (let cell = 0; cell < SIGNATURE_CELLS; cell++) {
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
    const a = new Uint8Array(SIGNATURE_LENGTH).fill(40)
    const b = new Uint8Array(SIGNATURE_LENGTH).fill(40)
    // Only the blue channel of the first cell.
    b[2] = 40 + CELL_DELTA * 2
    assert.equal(frameDistance(a, b), 1 / SIGNATURE_CELLS)
  })

  it('reports the fraction of repainted cells', () => {
    const changed = SIGNATURE_CELLS / 4
    assert.equal(frameDistance(signature(0), signature(changed)), 0.25)
  })

  it('is 1 when every cell is repainted', () => {
    assert.equal(frameDistance(signature(0), signature(SIGNATURE_CELLS)), 1)
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
    const selected = selectDistinctFrames([
      candidate(0, 0),
      candidate(1, 0),
      candidate(2, SIGNATURE_CELLS / 2),
      candidate(3, SIGNATURE_CELLS / 2),
    ])
    assert.deepEqual(
      selected.map((f) => f.time),
      [0, 2],
    )
  })

  it('accumulates a slow change against the last kept frame', () => {
    // Each step alone is below threshold; measured against the kept anchor the
    // drift eventually clears it, so a gradual fade is not lost entirely.
    const creeping = Array.from({ length: 30 }, (_, i) => candidate(i, i))
    const selected = selectDistinctFrames(creeping)
    assert.ok(selected.length > 1, 'a slow change should still produce a second frame')
    assert.ok(selected.length < creeping.length, 'but not one frame per step')
  })

  it('demands more change from frames sampled less than a second apart', () => {
    // The same repaint, sampled at 4fps and at 2s intervals. The tight sampling
    // has to clear a 3x-ish bar, so the burst does not turn into a frame each.
    const changed = Math.round(SIGNATURE_CELLS * 0.03)
    const burst = [candidate(0, 0), candidate(0.25, changed), candidate(0.5, changed * 2)]
    const spread = [candidate(0, 0), candidate(2, changed), candidate(4, changed * 2)]
    assert.ok(selectDistinctFrames(burst).length < selectDistinctFrames(spread).length)
  })

  it('honours maxFrames by dropping the least-changed frames', () => {
    const candidates = [
      candidate(0, 0),
      candidate(2, Math.round(SIGNATURE_CELLS * 0.05)),
      candidate(4, SIGNATURE_CELLS),
      // Unchanged from t=4, so it never earns a place of its own.
      candidate(6, SIGNATURE_CELLS),
    ]
    const selected = selectDistinctFrames(candidates, { maxFrames: 2 })
    assert.equal(selected.length, 2)
    assert.equal(selected[0]?.time, 0, 'the opening frame is always the baseline')
    assert.equal(selected[1]?.time, 4, 'the biggest repaint survives the cap')
  })

  it('returns capped frames in time order', () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      candidate(i, i % 2 === 0 ? SIGNATURE_CELLS : 0),
    )
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
      candidate(i, Math.round(SIGNATURE_CELLS * 0.03) * (i % 2)),
    )
    const high = selectDistinctFrames(candidates, { sensitivity: 'high' })
    const low = selectDistinctFrames(candidates, { sensitivity: 'low' })
    assert.ok(low.length <= high.length)
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
})
