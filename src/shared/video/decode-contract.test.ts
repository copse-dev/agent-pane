import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_TARGET_SAMPLES,
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
