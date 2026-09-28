import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderSummaryBlock, type PrSummary } from './pr-summary.ts'
import {
  caseTruth,
  compareScores,
  decodeRiskCorpus,
  outcomeProfile,
  parsePostedRating,
  pathSurfaces,
  postedRatings,
  renderOutcomeProfile,
  renderRiskReport,
  rubricClauses,
  scoreRatings,
  sizeBucket,
  type RiskCase,
  type RiskCorpus,
  type RiskEvidence,
  type RiskRatingSet,
} from './risk-eval.ts'

const summary: PrSummary = {
  risk: 'medium',
  riskReason: 'Changes the persisted report shape and the IPC payload.',
  overview: ['Adds an optional initiator field to review reports.'],
}

function evidence(verdict: RiskEvidence['verdict'], ref = '#2'): RiskEvidence {
  return {
    source: 'reference',
    ref,
    title: 'Fix the thing',
    daysAfterMerge: 1,
    excerpt: 'a regression from #1',
    verdict,
  }
}

function riskCase(number: number, overrides: Partial<RiskCase> = {}): RiskCase {
  return {
    number,
    title: `Change ${String(number)}`,
    state: 'merged',
    mergedAt: '2026-09-01T00:00:00Z',
    cohort: 'mature',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    size: { files: 2, additions: 40, deletions: 10, sourceLines: 50, sourceDeletions: 10 },
    areas: ['src/main'],
    surfaces: [],
    posted: null,
    observedDays: 7,
    evidence: [],
    ...overrides,
  }
}

function corpus(cases: RiskCase[]): RiskCorpus {
  return {
    version: 1,
    repo: 'o/r',
    collectedAt: '2026-09-27T00:00:00Z',
    windowDays: 7,
    cases,
  }
}

function ratings(entries: RiskRatingSet['ratings'], label = 'run'): RiskRatingSet {
  return {
    kind: 'copse-risk-ratings',
    label,
    source: 'mock',
    reviewerRevision: null,
    promptDigest: null,
    generatedAt: '2026-09-27T00:00:00Z',
    ratings: entries,
  }
}

describe('parsePostedRating', () => {
  it('reads the level, reason and footer of a block renderSummaryBlock wrote', () => {
    const block = renderSummaryBlock(summary, {
      headCommit: 'c'.repeat(40),
      toolVersion: '0.1.0',
      report: null,
    })
    const body = `## Outcome\n\nThe author's text.\n\n${block}`
    assert.deepEqual(parsePostedRating(body), {
      risk: 'medium',
      modelRisk: 'medium',
      reason: 'Changes the persisted report shape and the IPC payload.',
      raisedBecause: null,
      commit: 'c'.repeat(12),
      reviewIssues: null,
    })
  })

  it("recovers the model's level from a block the evidence floor raised", () => {
    const raised: PrSummary = {
      ...summary,
      risk: 'high',
      raisedBecause: 'the review surfaced 1 high-severity issue',
    }
    const block = renderSummaryBlock(raised, {
      headCommit: null,
      toolVersion: '0.1.0',
      report: null,
    })
    const rating = parsePostedRating(block)
    assert.ok(rating !== null)
    assert.equal(rating.risk, 'high')
    assert.equal(rating.modelRisk, 'medium')
    assert.equal(rating.raisedBecause, 'the review surfaced 1 high-severity issue')
  })

  it('ignores a description without a block, and a block the author edited', () => {
    assert.equal(parsePostedRating(null), null)
    assert.equal(parsePostedRating('Just prose, **High risk** in passing.'), null)
    const block = renderSummaryBlock(summary, {
      headCommit: null,
      toolVersion: '0.1.0',
      report: null,
    })
    assert.equal(parsePostedRating(block.replace('**Medium risk**', '**Low risk**')), null)
  })
})

describe('caseTruth', () => {
  it('is Low with no evidence or only unrelated mentions', () => {
    assert.deepEqual(caseTruth(riskCase(1)), { labelled: true, level: 'low', because: [] })
    assert.equal(caseTruth(riskCase(1, { evidence: [evidence('unrelated')] })).labelled, true)
  })

  it('is High for a regression and Medium for a cosmetic or incomplete one', () => {
    const high = caseTruth(
      riskCase(1, { evidence: [evidence('incomplete'), evidence('regression', '#3')] }),
    )
    assert.deepEqual(high, { labelled: true, level: 'high', because: ['reference #3'] })
    const cosmetic = caseTruth(riskCase(1, { evidence: [evidence('cosmetic')] }))
    assert.deepEqual(cosmetic, { labelled: true, level: 'medium', because: ['reference #2'] })
  })

  it('has no truth for a change that never merged, so it is not scored', () => {
    const open = riskCase(1, { state: 'open', mergedAt: null, observedDays: 0 })
    assert.deepEqual(caseTruth(open), { labelled: false, pending: ['not merged'] })
    const score = scoreRatings(
      corpus([open]),
      ratings([{ number: 1, risk: 'high', reason: 'IPC.' }]),
    )
    assert.equal(score.all.scored, 0)
    assert.deepEqual(score.unlabelled, [{ number: 1, pending: ['not merged'] }])
  })

  it('stays unlabelled while any item is unverified', () => {
    const truth = caseTruth(
      riskCase(1, { evidence: [evidence('regression'), evidence('unverified', '#9')] }),
    )
    assert.deepEqual(truth, { labelled: false, pending: ['reference #9'] })
  })

  it('does not infer Low truth before a change merges', () => {
    assert.deepEqual(caseTruth(riskCase(1, { state: 'open', mergedAt: null })), {
      labelled: false,
      pending: ['not merged'],
    })
    assert.deepEqual(caseTruth(riskCase(2, { state: 'closed', mergedAt: null })), {
      labelled: false,
      pending: ['not merged'],
    })
  })
})

describe('rubric clauses and surfaces', () => {
  it('names the clauses a reason cites', () => {
    assert.deepEqual(
      rubricClauses(
        'The change crosses renderer-to-main agent dispatch and persisted thread review metadata, including an API protocol version bump.',
      ),
      ['persisted-data', 'process-ipc'],
    )
    assert.deepEqual(rubricClauses('Documentation only.'), [])
  })

  it('does not read a Process Manager row or design tokens as a trust boundary', () => {
    assert.deepEqual(rubricClauses('Groups Process Manager rows by thread.'), [])
    assert.deepEqual(pathSurfaces(['src/renderer/styles/tokens.css'], ['src/renderer']), [])
  })

  it('maps source paths to the surfaces a surface-only rubric would see', () => {
    assert.deepEqual(
      pathSurfaces(
        [
          'src/main/services/security/permission-policy.ts',
          'pnpm-lock.yaml',
          'src/shared/types/ipc.ts',
        ],
        ['src/main', 'src/shared'],
      ),
      ['security', 'permissions-sandboxing', 'process-ipc', 'dependency-build'],
    )
    assert.deepEqual(pathSurfaces(['a/x.ts'], ['a', 'b', 'c', 'd']), ['cross-cutting'])
  })

  it('buckets size by source lines', () => {
    assert.equal(sizeBucket(99), 'small')
    assert.equal(sizeBucket(100), 'medium')
    assert.equal(sizeBucket(500), 'large')
  })
})

describe('scoreRatings', () => {
  const cases = corpus([
    riskCase(1),
    riskCase(2, { evidence: [evidence('regression')] }),
    riskCase(3, { evidence: [evidence('incomplete')], observedDays: 1 }),
    riskCase(4, { evidence: [evidence('unverified')] }),
    riskCase(5),
    riskCase(6, { state: 'open', mergedAt: null, cohort: 'case-study', observedDays: 0 }),
  ])

  it('fills the confusion matrix and separates over- from under-rating', () => {
    const score = scoreRatings(
      cases,
      ratings([
        { number: 1, risk: 'high', reason: 'Touches the sandbox policy.' },
        { number: 2, risk: 'medium', reason: 'A bounded runtime change.' },
        { number: 3, risk: 'medium', reason: 'A bounded runtime change.' },
        { number: 4, risk: 'low', reason: 'Docs.' },
        { number: 5, error: 'the summary did not complete' },
        { number: 6, risk: 'low', reason: 'No outcome evidence.' },
      ]),
    )
    assert.equal(score.all.scored, 3)
    assert.equal(score.all.matrix.high.low, 1)
    assert.equal(score.all.matrix.medium.high, 1)
    assert.equal(score.all.matrix.medium.medium, 1)
    assert.deepEqual([score.all.exact, score.all.over, score.all.under], [1, 1, 1])
    assert.deepEqual([score.all.regressions, score.all.missedRegressions], [1, 1])
    assert.equal(score.mature.scored, 2, 'the one-day case is not mature')
    assert.deepEqual(score.unrated, [5])
    assert.deepEqual(score.unlabelled, [
      { number: 4, pending: ['reference #2'] },
      { number: 6, pending: ['not merged'] },
    ])
    const sandbox = score.clauses.find((stat) => stat.clause === 'permissions-sandboxing')
    assert.deepEqual(
      sandbox && [sandbox.cited, sandbox.ratedHigh, sandbox.overRated, sandbox.smallChanges],
      [1, 1, 1, 1],
    )
    const report = renderRiskReport(score)
    assert.match(report, /\| high \| 1 \| 0 \| 0 \|/)
    assert.match(report, /\| #1 \| high ↑ \| low \|/)
    assert.match(report, /\| #2 \| medium ↓ \| high \|/)
  })

  it('scores the posted ratings as their own set, and lists the cases two sets disagree on', () => {
    const withPosted = corpus([
      riskCase(1, {
        posted: {
          risk: 'high',
          modelRisk: 'high',
          reason: 'IPC.',
          raisedBecause: null,
          commit: null,
          reviewIssues: null,
        },
      }),
      riskCase(2),
    ])
    const posted = scoreRatings(withPosted, postedRatings(withPosted))
    assert.equal(posted.cases.length, 1)
    assert.deepEqual(posted.unrated, [2])
    const after = scoreRatings(withPosted, ratings([{ number: 1, risk: 'low', reason: 'Small.' }]))
    assert.deepEqual(compareScores(posted, after), [
      { number: 1, truth: 'low', before: 'high', after: 'low' },
    ])
  })
})

describe('outcomeProfile', () => {
  it('splits outcomes by surface and size without any rater', () => {
    const profile = outcomeProfile(
      corpus([
        riskCase(1, { surfaces: ['persisted-data'] }),
        riskCase(2, {
          surfaces: ['permissions-sandboxing'],
          size: { files: 9, additions: 300, deletions: 10, sourceLines: 310, sourceDeletions: 10 },
          evidence: [evidence('regression')],
        }),
        riskCase(3, { observedDays: 2 }),
        riskCase(4, { state: 'open', mergedAt: null }),
      ]),
      true,
    )
    assert.equal(profile.cases, 2)
    const row = (label: string): readonly number[] => {
      const found = profile.rows.find((entry) => entry.label.trim() === label)
      return found === undefined ? [] : [found.cases, found.truth.high]
    }
    assert.deepEqual(row('touches a high-risk surface'), [2, 1])
    assert.deepEqual(row('persisted-data'), [1, 0])
    assert.deepEqual(row('touches a surface, under 100 source lines'), [1, 0])
    assert.deepEqual(row('touches a surface, 100 or more source lines'), [1, 1])
    assert.match(renderOutcomeProfile(profile), /\| all \| 2 \| 1 \| 0 \| 1 \| 50% \|/)
  })
})

describe('decodeRiskCorpus', () => {
  it('accepts a corpus and rejects an unknown verdict', () => {
    const good = corpus([riskCase(1, { evidence: [evidence('cosmetic')] })])
    assert.deepEqual(decodeRiskCorpus(JSON.parse(JSON.stringify(good))), good)
    const bad: unknown = JSON.parse(JSON.stringify(good).replace('"cosmetic"', '"probably"'))
    assert.equal(decodeRiskCorpus(bad), null)
  })
})
