import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIVE_ANCHOR_TOLERANCE,
  MIN_LIVE_ANCHORS,
  liveIntellectCandidates,
  verifyLiveCohort,
  type LiveAaModel,
} from './live-intellect.ts'

// A live feed on the canonical scale: anchors match the curated measurements
// (Fable 60, Opus 56), plus models we never curated.
const CANONICAL_FEED: LiveAaModel[] = [
  { id: 'claude-fable-5', intellect: 60 },
  { id: 'claude-opus-4-8', intellect: 56.4 }, // rerun jitter within tolerance
  { id: 'mimo-v2-5-pro', intellect: 53, inputPricePerMTok: 0.5, outputPricePerMTok: 2 },
  { id: 'grok-5-fast', intellect: 44 }, // no pricing reported
]

describe('verifyLiveCohort', () => {
  it('verifies a feed whose anchors match the curated canonical values', () => {
    const v = verifyLiveCohort(CANONICAL_FEED)
    assert.equal(v.verified, true)
    assert.ok(v.anchorsChecked >= MIN_LIVE_ANCHORS)
    assert.ok(v.maxDrift <= LIVE_ANCHOR_TOLERANCE)
    assert.deepEqual(v.mismatches, [])
  })

  it('rejects a renormalised feed — the v4.0-style cohort must never mix in', () => {
    const v = verifyLiveCohort([
      { id: 'claude-opus-4-8', intellect: 61 },
      { id: 'GPT-5.5', intellect: 60 },
      { id: 'new-model', intellect: 50 },
    ])
    assert.equal(v.verified, false)
    assert.ok(v.mismatches.length >= 1)
  })

  it('stays unverified with too few anchors — unknown scale is not a pass', () => {
    const v = verifyLiveCohort([
      { id: 'claude-opus-4-8', intellect: 56 },
      { id: 'unknown-model', intellect: 40 },
    ])
    assert.equal(v.verified, false)
    assert.equal(v.anchorsChecked, 1)
  })

  it("trusts the feed's declared version: canonical passes, any other refuses", () => {
    // API reports versions with the v dropped ("4.1").
    const canonical = verifyLiveCohort(CANONICAL_FEED, '4.1')
    assert.equal(canonical.verified, true)
    assert.equal(canonical.reportedVersion, 'v4.1')
    const next = verifyLiveCohort(CANONICAL_FEED, 4.2)
    assert.equal(next.verified, false)
    assert.equal(next.versionMismatch, true)
    assert.equal(next.reportedVersion, 'v4.2')
  })

  it('anchor defense still applies when the declared version matches', () => {
    // A feed claiming v4.1 whose anchor values are v4.0-shaped is refused.
    const v = verifyLiveCohort(
      [
        { id: 'claude-opus-4-8', intellect: 61 },
        { id: 'claude-fable-5', intellect: 65 },
      ],
      '4.1',
    )
    assert.equal(v.verified, false)
    assert.ok(v.mismatches.length > 0)
  })
})

describe('liveIntellectCandidates', () => {
  it('adds only uncurated models, split by pricing availability, all estimated', () => {
    const { candidates, hintOnly, verification } = liveIntellectCandidates(CANONICAL_FEED)
    assert.equal(verification.verified, true)
    // Curated anchors never re-enter via the feed.
    assert.ok(!candidates.some((c) => c.id.startsWith('claude-')))
    assert.deepEqual(hintOnly, [{ id: 'grok-5-fast', intellect: 44 }])
    assert.equal(candidates.length, 1)
    const [mimo] = candidates
    assert.ok(mimo)
    assert.equal(mimo.id, 'mimo-v2-5-pro')
    assert.equal(mimo.intellectEstimated, true)
    // 0.8·0.5 + 0.2·2 = $0.80/MTok blended.
    assert.equal(mimo.costPerMTok, 0.8)
  })

  it('returns nothing at all from an unverified cohort', () => {
    const { candidates, hintOnly, verification } = liveIntellectCandidates([
      { id: 'claude-opus-4-8', intellect: 61 },
      { id: 'claude-fable-5', intellect: 65 },
      { id: 'new-model', intellect: 50, inputPricePerMTok: 1 },
    ])
    assert.equal(verification.verified, false)
    assert.deepEqual(candidates, [])
    assert.deepEqual(hintOnly, [])
  })
})
