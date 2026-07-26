import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_TARGET_SAMPLES,
  frameSizeFor,
  MAX_SAMPLE_INTERVAL_SECONDS,
  MIN_SAMPLE_INTERVAL_SECONDS,
  resolveSampleInterval,
} from './decode-contract.ts'

describe('resolveSampleInterval', () => {
  it('aims at DEFAULT_TARGET_SAMPLES across the window', () => {
    // 57s / 119 gaps ≈ 479ms — same ballpark as the old fixed 0.5s grid, so a
    // full survey is no coarser than before the window-derived change.
    const fullSurvey = resolveSampleInterval(57)
    assert.ok(fullSurvey > 0.47 && fullSurvey < 0.49)
    assert.equal(DEFAULT_TARGET_SAMPLES, 120)

    // Narrowing buys temporal resolution: 5s → ~42ms, 2.5s → one 30fps frame.
    assert.ok(Math.abs(resolveSampleInterval(5) - 5 / 119) < 1e-9)
    assert.equal(resolveSampleInterval(2.5), MIN_SAMPLE_INTERVAL_SECONDS)
  })

  it('honours an explicit positive interval and clamps to the allowed band', () => {
    assert.equal(resolveSampleInterval(57, 0.05), 0.05)
    assert.equal(
      resolveSampleInterval(57, MIN_SAMPLE_INTERVAL_SECONDS / 2),
      MIN_SAMPLE_INTERVAL_SECONDS,
    )
    assert.equal(resolveSampleInterval(57, 10), MAX_SAMPLE_INTERVAL_SECONDS)
  })

  it('treats null/undefined/non-positive requests as "derive from the window"', () => {
    const derived = resolveSampleInterval(10)
    assert.equal(resolveSampleInterval(10, null), derived)
    assert.equal(resolveSampleInterval(10, undefined), derived)
    assert.equal(resolveSampleInterval(10, 0), derived)
    assert.equal(resolveSampleInterval(10, -1), derived)
  })

  it('falls back to the finest interval for a zero-length window', () => {
    assert.equal(resolveSampleInterval(0), MIN_SAMPLE_INTERVAL_SECONDS)
    assert.equal(resolveSampleInterval(-1), MIN_SAMPLE_INTERVAL_SECONDS)
  })
})

describe('frameSizeFor', () => {
  it('fits a landscape frame to the budget on its width', () => {
    assert.deepEqual(frameSizeFor(2560, 1440, 1280), { width: 1280, height: 720 })
  })

  it('fits a portrait frame to the budget on its height', () => {
    // The bug this replaced scaled on width alone, so this 2296x3916 capture
    // came back 1280x2183 — 2.8M pixels against the 0.96M a landscape frame
    // gets from the same budget. Image tokens are priced on pixel dimensions,
    // so a portrait recording silently cost ~3x per frame.
    const size = frameSizeFor(2296, 3916, 1280)
    assert.equal(size.height, 1280)
    assert.ok(size.width < size.height)
    assert.ok(size.width * size.height < 1280 * 1280)
  })

  it('never upscales a frame smaller than the budget', () => {
    assert.deepEqual(frameSizeFor(640, 480, 1280), { width: 640, height: 480 })
  })

  it('keeps the source aspect ratio', () => {
    const size = frameSizeFor(2296, 3916, 1280)
    assert.ok(Math.abs(size.width / size.height - 2296 / 3916) < 0.01)
  })

  it('falls back to a 16:9 frame when the video reports no dimensions', () => {
    assert.deepEqual(frameSizeFor(0, 0, 1280), { width: 1280, height: 720 })
  })
})
