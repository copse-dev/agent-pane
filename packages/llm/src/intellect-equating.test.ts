import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeEquating,
  equateAcrossVersions,
  fitLinearEquating,
  type EquatingMap,
} from './intellect-equating.ts'

const ANCHORS = [
  { fromValue: 30, toValue: 34 },
  { fromValue: 40, toValue: 44 },
  { fromValue: 50, toValue: 54 },
]

describe('fitLinearEquating', () => {
  it('recovers an exact linear relationship from anchors', () => {
    const map = fitLinearEquating('v4.2', 'v4.1', ANCHORS, '2026-07-18')
    assert.ok(Math.abs(map.a - 1) < 1e-9)
    assert.ok(Math.abs(map.b - 4) < 1e-9)
    assert.equal(map.anchorCount, 3)
    assert.equal(map.anchorMin, 30)
    assert.equal(map.anchorMax, 50)
  })

  it('rejects too-few or spreadless anchors', () => {
    assert.throws(() => fitLinearEquating('a', 'b', [{ fromValue: 1, toValue: 2 }], '2026-01-01'))
    assert.throws(() =>
      fitLinearEquating(
        'a',
        'b',
        [
          { fromValue: 5, toValue: 2 },
          { fromValue: 5, toValue: 3 },
        ],
        '2026-01-01',
      ),
    )
  })
})

describe('equateAcrossVersions', () => {
  const maps: EquatingMap[] = [
    fitLinearEquating('v4.2', 'v4.1', ANCHORS, '2026-07-18'),
    fitLinearEquating(
      'v5',
      'v4.2',
      [
        { fromValue: 20, toValue: 30 },
        { fromValue: 40, toValue: 50 },
      ],
      '2026-07-18',
    ),
  ]

  it('is the identity within one version', () => {
    const r = equateAcrossVersions(56, 'v4.1', 'v4.1', maps)
    assert.deepEqual(r, { value: 56, extrapolated: false, hops: [] })
  })

  it('translates one hop within the anchor range without an extrapolation flag', () => {
    const r = equateAcrossVersions(45, 'v4.2', 'v4.1', maps)
    assert.ok(r)
    assert.equal(r.value, 49)
    assert.equal(r.extrapolated, false)
    assert.equal(r.hops.length, 1)
  })

  it('flags values outside the anchor range as extrapolated', () => {
    const r = equateAcrossVersions(58, 'v4.2', 'v4.1', maps)
    assert.ok(r)
    assert.equal(r.value, 62)
    assert.equal(r.extrapolated, true)
    assert.match(describeEquating(r), /extrapolated beyond anchor range/)
  })

  it('chains hops and reports the route in the description', () => {
    const r = equateAcrossVersions(30, 'v5', 'v4.1', maps)
    assert.ok(r)
    // v5 30 → v4.2 40 → v4.1 44
    assert.equal(r.value, 44)
    assert.equal(r.hops.length, 2)
    assert.match(describeEquating(r), /v5→v4\.2, v4\.2→v4\.1/)
  })

  it('returns null when no path exists', () => {
    assert.equal(equateAcrossVersions(50, 'v3', 'v4.1', maps), null)
  })
})
