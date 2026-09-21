import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateScores,
  anchorsOverlap,
  decodeReviewCase,
  matchDefect,
  reportUsage,
  scoreCase,
  type TruthDefect,
} from './eval.ts'
import type { Finding } from './finding.ts'
import type { Stage0Report } from './stage0.ts'
import type { ReviewReport } from './stage5.ts'

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    anchor: { path: 'src/a.cjs', startLine: 10, endLine: 12 },
    claim: 'a claim',
    class: 'contract',
    severity: 'high',
    confidence: 'high',
    provenance: {
      raisedBy: [{ kind: 'model', id: 'm', lens: 'correctness' }],
      corroboratedBy: [],
      challengedBy: [],
    },
    evidence: [],
    verdict: { status: 'unverified', reason: 'r' },
    ...overrides,
  }
}

const stage0: Stage0Report = {
  version: 1,
  repositoryRoot: '/r',
  baseRef: 'main',
  mergeBase: 'a',
  headCommit: 'b',
  dirtyWorkingTree: false,
  execution: { backend: 'host-process', strength: 'none', decision: { execute: true, reason: '' } },
  project: { head: null, base: null },
  preparation: { head: null, base: null },
  checks: [],
  findings: [],
  coverage: { checked: [], notChecked: [] },
  durationMs: 0,
}

function report(findings: Finding[], overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    version: 2,
    stage0,
    context: null,
    reviews: [
      {
        model: 'm',
        lens: 'correctness',
        turnId: 't',
        outcome: 'completed',
        stopReason: 'end_turn',
        candidates: findings.length,
        toolCalls: 1,
        usage: { inputTokens: 100, outputTokens: 20, estimated: false },
        summary: '',
      },
    ],
    verification: null,
    findings,
    appendix: [],
    refuted: [],
    durationMs: 1,
    ...overrides,
  }
}

const defect: TruthDefect = {
  id: 'd1',
  class: 'contract',
  anchors: [{ path: 'src/a.cjs', startLine: 11, endLine: 11 }],
  regressions: ['test'],
}

describe('review eval scoring', () => {
  it('overlaps line ranges within the cluster slack, and whole files always', () => {
    assert.equal(anchorsOverlap({ startLine: 10, endLine: 12 }, { startLine: 15 }), true)
    assert.equal(anchorsOverlap({ startLine: 10, endLine: 12 }, { startLine: 16 }), false)
    assert.equal(anchorsOverlap({ startLine: 20 }, { startLine: 10, endLine: 12 }), false)
    assert.equal(anchorsOverlap({}, { startLine: 400 }), true)
  })

  it('matches a finding to a defect by anchor, by regression for Stage 0, and not otherwise', () => {
    assert.equal(matchDefect(finding({ id: 'a' }), [defect])?.how, 'anchor')
    assert.equal(
      matchDefect(finding({ id: 'b', anchor: { path: './src/a.cjs', startLine: 14 } }), [defect])
        ?.how,
      'anchor',
      'slack and a ./ prefix still match',
    )
    assert.equal(
      matchDefect(finding({ id: 'c', anchor: { path: 'src/b.cjs', startLine: 11 } }), [defect]),
      null,
    )
    const stage0Test = finding({
      id: 'd',
      anchor: { path: 'package.json', startLine: 3 },
      class: 'test',
      provenance: {
        raisedBy: [{ kind: 'stage0', id: 'stage0' }],
        corroboratedBy: [],
        challengedBy: [],
      },
    })
    assert.equal(matchDefect(stage0Test, [defect])?.how, 'regression')
    assert.equal(
      matchDefect({ ...stage0Test, class: 'build' }, [defect]),
      null,
      'a build regression is not the test regression the defect declares',
    )
    assert.equal(
      matchDefect({ ...stage0Test, provenance: finding({ id: 'x' }).provenance }, [defect]),
      null,
      'a model finding at package.json is not a regression match',
    )
  })

  it('scores surfaced findings only, counting distinct defects found', () => {
    const hitA = finding({ id: '1', verdict: { status: 'confirmed', reason: 'r' } })
    const hitB = finding({
      id: '2',
      anchor: { path: 'src/a.cjs', startLine: 12 },
      class: 'resource',
      evidence: [{ kind: 'reproducer', testPath: 't', failsOnHead: true, passesOnBase: true }],
      verdict: { status: 'confirmed', reason: 'r' },
    })
    const miss = finding({ id: '3', anchor: { path: 'src/z.cjs', startLine: 1 } })
    const score = scoreCase(
      'case',
      report([hitA, hitB, miss], {
        appendix: [finding({ id: '4' })],
        refuted: [finding({ id: '5' })],
      }),
      [defect],
    )
    assert.equal(score.surfaced, 3)
    assert.equal(score.truePositives, 2)
    assert.equal(score.falsePositives, 1)
    assert.equal(score.found, 1, 'two hits on one defect count it once')
    assert.equal(score.confirmed, 2)
    assert.equal(score.confirmedByReproducer, 1)
    assert.deepEqual(
      score.findings.map((entry) => [entry.defectId, entry.classAgrees]),
      [
        ['d1', true],
        ['d1', false],
        [null, false],
      ],
    )
  })

  it('aggregates precision, secondary recall, reproducer rate and tokens per confirmed', () => {
    const one = scoreCase(
      'one',
      report([finding({ id: '1', verdict: { status: 'confirmed', reason: 'r' } })]),
      [defect],
    )
    const clean = scoreCase('clean', report([finding({ id: '2' })]), [])
    const empty = scoreCase('empty', report([]), [])
    const usage = reportUsage(
      report([], {
        verification: {
          counts: {
            attempted: 1,
            confirmed: 1,
            refuted: 0,
            survived: 0,
            undetermined: 0,
            skipped: 0,
          },
          records: [],
          reproducers: [],
          usage: { inputTokens: 50, outputTokens: 30, estimated: false },
        },
      }),
    )
    assert.deepEqual(usage, { inputTokens: 150, outputTokens: 50 })
    const metrics = aggregateScores([one, clean, empty], [usage, usage, usage])
    assert.equal(metrics.cases, 3)
    assert.equal(metrics.surfaced, 2)
    assert.equal(metrics.truePositives, 1)
    assert.equal(metrics.precision, 0.5)
    assert.equal(metrics.recall, 1)
    assert.equal(metrics.confirmed, 1)
    assert.equal(metrics.reproducerRate, 0)
    assert.equal(metrics.outputTokens, 150)
    assert.equal(metrics.outputTokensPerConfirmed, 150)
    const nothing = aggregateScores([empty], [])
    assert.equal(nothing.precision, null)
    assert.equal(nothing.recall, null)
    assert.equal(nothing.outputTokensPerConfirmed, null)
  })

  it('decodes a case file and rejects a malformed one', () => {
    assert.deepEqual(decodeReviewCase({ id: 'c', truth: [] }), { id: 'c', truth: [] })
    assert.equal(
      decodeReviewCase({ id: 'c', truth: [{ id: 'd', class: 'vibes', anchors: [] }] }),
      null,
    )
    assert.equal(
      decodeReviewCase({ id: 'c', truth: [{ id: 'd', class: 'test', anchors: [] }] }),
      null,
    )
  })
})
