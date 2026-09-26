import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderReviewReport, renderStage0Report } from './report-text.ts'
import type { Stage0Report } from './stage0.ts'
import type { ReviewReport, ReviewerSummary } from './stage5.ts'

const cleanStage0: Stage0Report = {
  version: 1,
  repositoryRoot: '/repo',
  baseRef: 'origin/main',
  mergeBase: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  dirtyWorkingTree: false,
  execution: {
    backend: 'host-process',
    strength: 'none',
    decision: { execute: true, reason: 'own tree with consent' },
  },
  project: { head: null, base: null },
  preparation: { head: null, base: null },
  checks: [{ kind: 'test', verdict: 'clean', head: null, base: null }],
  findings: [],
  coverage: { checked: ['test'], notChecked: [] },
  durationMs: 10,
}

function reviewer(outcome: ReviewerSummary['outcome']): ReviewerSummary {
  return {
    model: 'gpt-5',
    lens: 'correctness',
    turnId: 't1',
    outcome,
    stopReason: outcome === 'completed' ? 'end_turn' : 'error',
    candidates: 0,
    toolCalls: 1,
    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
    summary: '',
    completion:
      outcome === 'completed' ? { checked: 'The change.', couldNotVerify: 'Nothing' } : null,
    ...(outcome === 'completed' ? {} : { error: 'provider returned 500' }),
  }
}

function review(reviews: readonly ReviewerSummary[]): ReviewReport {
  return {
    version: 2,
    stage0: cleanStage0,
    context: null,
    reviews,
    verification: null,
    findings: [],
    appendix: [],
    refuted: [],
    durationMs: 100,
  }
}

describe('terminal report', () => {
  it('says Clean. for a clean Stage 0 on its own', () => {
    assert.match(renderStage0Report(cleanStage0), /\nClean\.$/)
  })

  it('never says Clean. inside a review whose reviewer failed', () => {
    const text = renderReviewReport(review([reviewer('failed')]))
    assert.doesNotMatch(text, /^Clean\.$/m)
    assert.match(text, /^Stage 0: no regressions\.$/m)
    assert.match(text, /Review incomplete: 1 of 1 reviewer run\(s\) did not complete/)
  })

  it('leaves the overall verdict to the end of a completed review', () => {
    const text = renderReviewReport(review([reviewer('completed')]))
    assert.doesNotMatch(text, /^Clean\.$/m)
    assert.match(text, /\nNo findings\.$/)
  })
})
