import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Finding } from './finding.ts'
import type { ReportedCandidate } from './reviewer-tools.ts'
import type { Stage0Report } from './stage0.ts'
import {
  MAX_SURFACED_FINDINGS,
  assembleReviewReport,
  candidateToFinding,
  findingScore,
  mergeFindings,
  rankFindings,
} from './stage5.ts'

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    anchor: { path: 'src/a.ts', startLine: 10, endLine: 12 },
    claim: `claim ${overrides.id}`,
    class: 'test',
    severity: 'medium',
    confidence: 'medium',
    provenance: {
      raisedBy: [{ kind: 'model', id: 'm1', lens: 'correctness' }],
      corroboratedBy: [],
      challengedBy: [],
    },
    evidence: [{ kind: 'citation', path: 'src/a.ts', startLine: 10, endLine: 12 }],
    verdict: { status: 'unverified', reason: 'not yet' },
    ...overrides,
  }
}

const confirmed = finding({
  id: '1111111111111111',
  provenance: {
    raisedBy: [{ kind: 'stage0', id: 'stage0' }],
    corroboratedBy: [],
    challengedBy: [],
  },
  evidence: [
    { kind: 'command', command: 'pnpm run test', target: 'head', exitCode: 1, excerpt: 'not ok' },
  ],
  verdict: { status: 'confirmed', reason: 'fails on head, passes on base' },
  severity: 'high',
  confidence: 'high',
})

describe('findingScore and rankFindings', () => {
  it('ranks a confirmed, executed finding above an unverified single-model one', () => {
    const lone = finding({ id: '2222222222222222', anchor: { path: 'src/b.ts', startLine: 1 } })
    assert.ok(findingScore(confirmed) > findingScore(lone))
    assert.equal(findingScore(lone), 2 * 2 - 2)
    assert.equal(findingScore(confirmed), 3 * 3 + 3 + 4)
    const { surfaced } = rankFindings([lone, confirmed])
    assert.deepEqual(
      surfaced.map((f) => f.id),
      [confirmed.id, lone.id],
    )
  })

  it('drops refuted findings and caps the surfaced list', () => {
    const many = Array.from({ length: MAX_SURFACED_FINDINGS + 3 }, (_, index) =>
      finding({
        id: String(index).padStart(16, '0'),
        anchor: { path: `src/${String(index)}.ts`, startLine: 1 },
      }),
    )
    const refuted = finding({
      id: 'ffffffffffffffff',
      verdict: { status: 'refuted', reason: 'no' },
    })
    const { surfaced, appendix } = rankFindings([...many, refuted])
    assert.equal(surfaced.length, MAX_SURFACED_FINDINGS)
    assert.equal(appendix.length, 3)
    assert.equal(
      [...surfaced, ...appendix].some((f) => f.id === refuted.id),
      false,
    )
  })

  it('merges the same finding raised twice into one with corroboration', () => {
    const again = finding({
      id: '3333333333333333',
      anchor: { path: 'src/a.ts', startLine: 11, endLine: 11 },
      provenance: {
        raisedBy: [{ kind: 'model', id: 'm2', lens: 'correctness' }],
        corroboratedBy: [],
        challengedBy: [],
      },
    })
    const merged = mergeFindings([confirmed, again])
    const [only] = merged
    assert.ok(only)
    assert.equal(merged.length, 1)
    assert.deepEqual(only.provenance.corroboratedBy, [
      { kind: 'model', id: 'm2', lens: 'correctness' },
    ])
    assert.equal(only.verdict.status, 'confirmed')
    const different = finding({
      id: '4444444444444444',
      anchor: { path: 'src/a.ts', startLine: 40 },
    })
    assert.equal(mergeFindings([confirmed, different]).length, 2)
  })
})

describe('candidateToFinding', () => {
  it('anchors, identifies by content, marks unverified and attaches command evidence', () => {
    const reported: ReportedCandidate = {
      candidate: {
        path: 'src/a.ts',
        startLine: 3,
        class: 'contract',
        severity: 'high',
        confidence: 'medium',
        claim: 'The function returns the difference.',
        reason: 'a - b on line 3.',
        commandCallIds: ['call-1', 'call-missing'],
      },
      anchoredText: 'return a - b',
      toolCallId: 'f1',
    }
    const runs = new Map([
      [
        'call-1',
        {
          target: 'head' as const,
          argv: ['node', 'x.js'],
          exitCode: 1,
          signal: null,
          timedOut: false,
          durationMs: 5,
          output: 'boom',
          outputTruncated: false,
        },
      ],
    ])
    const result = candidateToFinding(reported, { model: 'm1', lens: 'correctness' }, runs)
    assert.match(result.id, /^[0-9a-f]{16}$/)
    assert.deepEqual(result.anchor, { path: 'src/a.ts', startLine: 3, endLine: 3 })
    assert.equal(result.verdict.status, 'unverified')
    assert.deepEqual(result.provenance.raisedBy, [{ kind: 'model', id: 'm1', lens: 'correctness' }])
    assert.deepEqual(
      result.evidence.map((evidence) => evidence.kind),
      ['citation', 'command'],
    )
    const same = candidateToFinding(
      { ...reported, toolCallId: 'f2' },
      { model: 'm9', lens: 'x' },
      new Map(),
    )
    assert.equal(same.id, result.id, 'identity comes from content, not from who raised it')
  })
})

describe('assembleReviewReport', () => {
  const stage0: Stage0Report = {
    version: 1,
    repositoryRoot: '/repo',
    baseRef: 'main',
    mergeBase: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    dirtyWorkingTree: false,
    execution: {
      backend: 'host-process',
      strength: 'none',
      decision: { execute: true, reason: 'ok' },
    },
    project: { head: null, base: null },
    preparation: { head: null, base: null },
    checks: [],
    findings: [confirmed],
    coverage: { checked: ['test'], notChecked: [] },
    durationMs: 1,
  }

  it('carries Stage 0 alone when no model ran', () => {
    const report = assembleReviewReport({
      stage0,
      context: null,
      stage2: null,
      startedAt: 0,
      now: () => 10,
    })
    assert.equal(report.review, null)
    assert.equal(report.context, null)
    assert.deepEqual(
      report.findings.map((f) => f.id),
      [confirmed.id],
    )
    assert.equal(report.durationMs, 10)
  })
})
