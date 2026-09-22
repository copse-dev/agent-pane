import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAIM_CONTAINMENT_THRESHOLD,
  CLAIM_SIMILARITY_THRESHOLD,
  claimContainment,
  claimSimilarity,
  claimTokens,
  clusterFindings,
  sameFinding,
} from './cluster.ts'
import type { Finding } from './finding.ts'

function finding(
  id: string,
  claim: string,
  anchor: Finding['anchor'],
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    anchor,
    claim,
    class: 'contract',
    severity: 'medium',
    confidence: 'medium',
    provenance: {
      raisedBy: [{ kind: 'model', id: `model-${id}`, lens: 'correctness' }],
      corroboratedBy: [],
      challengedBy: [],
    },
    evidence: [{ kind: 'citation', path: anchor.path, startLine: 1, endLine: 1 }],
    verdict: { status: 'unverified', reason: 'because' },
    ...overrides,
  }
}

describe('claim similarity', () => {
  it('meets on content words, not on phrasing', () => {
    assert.deepEqual(
      [...claimTokens('The function returns the difference instead of the sum.')].sort(),
      ['difference', 'function', 'return', 'sum'],
    )
    const a = 'add returns the difference of its arguments instead of their sum'
    const b = 'The add function returns a difference, not a sum.'
    assert.ok(claimSimilarity(a, b) >= CLAIM_SIMILARITY_THRESHOLD, String(claimSimilarity(a, b)))
    const c = 'The timeout is never cleared when the promise rejects'
    assert.ok(claimSimilarity(a, c) < CLAIM_SIMILARITY_THRESHOLD)
    assert.equal(claimSimilarity('', a), 0)
  })

  it('recognises a concise claim contained in a longer explanation', () => {
    const concise =
      'paginate now returns one item fewer than the requested page size, so every page loses its last item and the existing tests fail.'
    const detailed =
      'Changing the slice end to start + size - 1 makes paginate return pages with one fewer item than its contract and its consumer expects, so the test suite fails.'
    assert.ok(claimSimilarity(concise, detailed) < CLAIM_SIMILARITY_THRESHOLD)
    assert.ok(
      claimContainment(concise, detailed) >= CLAIM_CONTAINMENT_THRESHOLD,
      String(claimContainment(concise, detailed)),
    )
  })
})

describe('sameFinding', () => {
  const base = finding('1111111111111111', 'add returns the difference instead of the sum', {
    path: 'src/math.ts',
    startLine: 10,
    endLine: 12,
  })

  it('merges overlapping anchors with equivalent claims, within slack', () => {
    const near = finding('2222222222222222', 'The add function returns a difference, not a sum.', {
      path: 'src/math.ts',
      startLine: 14,
      endLine: 14,
    })
    assert.equal(sameFinding(base, near), true)
    const far = { ...near, anchor: { path: 'src/math.ts', startLine: 40, endLine: 40 } }
    assert.equal(sameFinding(base, far), false)
    const otherFile = { ...near, anchor: { path: 'src/other.ts', startLine: 11, endLine: 11 } }
    assert.equal(sameFinding(base, otherFile), false)
  })

  it('keeps different claims on the same lines apart, and different classes apart', () => {
    const different = finding(
      '3333333333333333',
      'The timeout is never cleared when the promise rejects',
      {
        path: 'src/math.ts',
        startLine: 11,
        endLine: 11,
      },
    )
    assert.equal(sameFinding(base, different), false)
    const otherClass = finding('4444444444444444', base.claim, base.anchor, { class: 'security' })
    assert.equal(sameFinding(base, otherClass), false)
  })

  it('treats an identical id as the same finding whatever else differs', () => {
    assert.equal(
      sameFinding(base, { ...base, claim: 'something else entirely', anchor: { path: 'x' } }),
      true,
    )
  })

  it('merges the concise and detailed forms of the same anchored defect', () => {
    const concise = finding(
      '5555555555555555',
      'paginate now returns one item fewer than the requested page size, so every page loses its last item and the existing tests fail.',
      { path: 'src/paginate.cjs', startLine: 4 },
      { class: 'test' },
    )
    const detailed = finding(
      '6666666666666666',
      'Changing the slice end to start + size - 1 makes paginate return pages with one fewer item than its contract and its consumer expects, so the test suite fails.',
      { path: 'src/paginate.cjs', startLine: 4 },
      { class: 'test' },
    )
    assert.equal(sameFinding(concise, detailed), true)
  })
})

describe('clusterFindings', () => {
  it('keeps the first member canonical, records corroborators, widens the anchor, carries commands', () => {
    const first = finding('1111111111111111', 'add returns the difference instead of the sum', {
      path: 'src/math.ts',
      startLine: 10,
      endLine: 12,
    })
    const second = finding(
      '2222222222222222',
      'The add function returns a difference, not a sum.',
      {
        path: 'src/math.ts',
        startLine: 12,
        endLine: 15,
      },
      {
        evidence: [
          { kind: 'citation', path: 'src/math.ts', startLine: 12, endLine: 15 },
          { kind: 'command', command: 'node t.js', target: 'head', exitCode: 1, excerpt: 'boom' },
        ],
      },
    )
    const third = finding(
      '3333333333333333',
      'The timeout is never cleared when the promise rejects',
      {
        path: 'src/math.ts',
        startLine: 11,
        endLine: 11,
      },
    )
    const clusters = clusterFindings([first, second, third])
    assert.equal(clusters.length, 2)
    const [merged, other] = clusters
    assert.ok(merged && other)
    assert.equal(merged.id, first.id)
    assert.equal(merged.claim, first.claim)
    assert.deepEqual(merged.anchor, { path: 'src/math.ts', startLine: 10, endLine: 15 })
    assert.deepEqual(merged.provenance.corroboratedBy, [
      { kind: 'model', id: 'model-2222222222222222', lens: 'correctness' },
    ])
    assert.deepEqual(
      merged.evidence.map((evidence) => evidence.kind),
      ['citation', 'command'],
    )
    assert.equal(other.id, third.id)
  })

  it('does not list the same reviewer twice as a corroborator', () => {
    const a = finding('1111111111111111', 'add returns the difference instead of the sum', {
      path: 'src/math.ts',
      startLine: 10,
    })
    const b = {
      ...finding('2222222222222222', 'add returns the difference, not the sum', {
        path: 'src/math.ts',
        startLine: 10,
      }),
      provenance: a.provenance,
    }
    const [merged] = clusterFindings([a, b])
    assert.deepEqual(merged?.provenance.corroboratedBy, [])
  })
})
