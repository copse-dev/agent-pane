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

  it('trusts a canonical feed despite a minority of stale anchors', () => {
    // Six anchors agree; one curated value is stale (our 24 vs a live 20). A
    // lone outlier is stale data, not a renormalised scale, so the feed still
    // verifies — with the outlier reported.
    const v = verifyLiveCohort([
      { id: 'claude-opus-4-8', intellect: 55.7 },
      { id: 'claude-fable-5', intellect: 59.9 },
      { id: 'claude-sonnet-4-6', intellect: 35.9 },
      { id: 'claude-sonnet-5', intellect: 53.4 },
      { id: 'gpt-4o', intellect: 11.2 },
      { id: 'gpt-5', intellect: 34.7 },
      { id: 'claude-haiku-4-5', intellect: 20 },
    ])
    assert.equal(v.verified, true)
    assert.equal(v.agreeingAnchors, 6)
    assert.equal(v.mismatches.length, 1)
    assert.equal(v.mismatches[0]?.modelId, 'claude-haiku-4-5')
  })

  it('still refuses when diverging anchors are not a minority (a real renorm)', () => {
    // Half the anchors shift — that is a scale change, not stale data.
    const v = verifyLiveCohort([
      { id: 'claude-opus-4-8', intellect: 55.7 },
      { id: 'claude-fable-5', intellect: 59.9 },
      { id: 'claude-sonnet-4-6', intellect: 41 },
      { id: 'gpt-4o', intellect: 18 },
    ])
    assert.equal(v.verified, false)
    assert.equal(v.mismatches.length, 2)
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

  it('prices a curated model from the feed without displacing its reviewed score', () => {
    const { candidates, pricedCurated } = liveIntellectCandidates([
      ...CANONICAL_FEED,
      // AA's bare slug for our curated moonshotai/kimi-k3 (57.1), with pricing.
      { id: 'kimi-k3', intellect: 57.4, inputPricePerMTok: 3, outputPricePerMTok: 15 },
    ])
    // Not a live candidate (it resolves to a curated measurement)…
    assert.ok(!candidates.some((c) => c.id.includes('kimi')))
    // …but it becomes a plottable point: curated score, live price.
    const kimi = pricedCurated.find((c) => c.id === 'moonshotai/kimi-k3')
    assert.ok(kimi)
    assert.equal(kimi.intellect, 57.1)
    assert.equal(kimi.intellectEstimated, false)
    assert.equal(kimi.costPerMTok, 5.4)
  })

  it('treats a zero or absent price as unpriced, not as a $0 candidate', () => {
    const { candidates, hintOnly } = liveIntellectCandidates([
      { id: 'claude-fable-5', intellect: 60 },
      { id: 'claude-opus-4-8', intellect: 56 },
      // AA free tier reports these with no usable price → belong in hintOnly,
      // never plotted at $0 where all but one would be dominated.
      { id: 'zero-priced', intellect: 40, inputPricePerMTok: 0, outputPricePerMTok: 0 },
      { id: 'no-price-field', intellect: 38 },
      { id: 'real-price', intellect: 42, inputPricePerMTok: 1, outputPricePerMTok: 3 },
    ])
    assert.ok(!candidates.some((c) => c.id === 'zero-priced'))
    assert.ok(hintOnly.some((h) => h.id === 'zero-priced'))
    assert.ok(hintOnly.some((h) => h.id === 'no-price-field'))
    const real = candidates.find((c) => c.id === 'real-price')
    assert.ok(real)
    assert.ok(Math.abs(real.costPerMTok - 1.4) < 1e-9)
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
