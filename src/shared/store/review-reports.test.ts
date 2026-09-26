import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, ReviewFindingRecord, Thread, ThreadReviewReport } from '@shared/types'
import {
  reviewReportModelContext,
  reviewReportsAwaitingModel,
  withReviewContext,
} from './review-reports.ts'

function message(id: string, role: Message['role'], createdAt: number): Message {
  return { id, role, content: id, toolCalls: [], createdAt }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    title: 't1',
    status: 'idle',
    messages: [message('u1', 'user', 10), message('a1', 'assistant', 20)],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function finding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    id: '0123456789abcdef',
    path: 'src/math.ts',
    startLine: 3,
    claim: 'add subtracts its second argument.',
    class: 'contract',
    severity: 'high',
    confidence: 'high',
    verdict: { status: 'confirmed', reason: 'The reproducer fails on head.' },
    raisedBy: ['gpt-5 (correctness)'],
    corroboratedBy: [],
    challengedBy: [],
    evidence: [],
    ...overrides,
  }
}

function report(overrides: Partial<ThreadReviewReport> = {}): ThreadReviewReport {
  return {
    status: 'done',
    startedAt: 30,
    initiator: 'user',
    models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
    lenses: ['correctness'],
    baseRef: 'main',
    headCommit: 'abc1234def5678',
    dirtyWorkingTree: false,
    execution: { backend: 'os-sandbox', strength: 'os-sandbox', executed: true, reason: '' },
    checks: [{ kind: 'test', verdict: 'regressed' }],
    notChecked: [],
    findings: [finding()],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 10,
    ...overrides,
  }
}

/** `a1` (the thread's last assistant message) carries `r`. */
function reviewedTurn(r: ThreadReviewReport, extra: Message[] = []): Thread {
  return thread({
    messages: [
      message('u1', 'user', 10),
      { ...message('a1', 'assistant', 20), reviewReport: r },
      ...extra,
    ],
  })
}

describe('reviewReportsAwaitingModel', () => {
  it('hands over a user review on the latest assistant turn, even once the next prompt is in', () => {
    const r = report()
    assert.deepEqual(reviewReportsAwaitingModel(reviewedTurn(r)), [r])
    // The prompt being dispatched is already in the transcript; its reply is not.
    assert.deepEqual(reviewReportsAwaitingModel(reviewedTurn(r, [message('u2', 'user', 40)])), [r])
  })

  it('stops handing it over once the model has replied after it', () => {
    const replied = reviewedTurn(report(), [
      message('u2', 'user', 40),
      message('a2', 'assistant', 50),
    ])
    assert.deepEqual(reviewReportsAwaitingModel(replied), [])
  })

  it('never hands over the agent’s own review, a failed or running one, or an unattributed one', () => {
    const { initiator: _initiator, ...unattributed } = report()
    for (const r of [
      report({ initiator: 'agent' }),
      report({ status: 'error', error: 'Review declined.' }),
      report({ status: 'running' }),
      unattributed,
    ]) {
      assert.deepEqual(reviewReportsAwaitingModel(reviewedTurn(r)), [])
    }
  })

  it('hands over a thread-level review until an assistant message is newer than its run', () => {
    const r = report({ startedAt: 30 })
    const before = thread({ messages: [message('u1', 'user', 10)], reviewReport: r })
    assert.deepEqual(reviewReportsAwaitingModel(before), [r])
    const after = thread({
      messages: [message('u1', 'user', 10), message('a1', 'assistant', 40)],
      reviewReport: r,
    })
    assert.deepEqual(reviewReportsAwaitingModel(after), [])
    // A reply stamped in the same millisecond as the run still counts as the reply.
    const sameMs = thread({
      messages: [message('u1', 'user', 10), message('a1', 'assistant', 30)],
      reviewReport: r,
    })
    assert.deepEqual(reviewReportsAwaitingModel(sameMs), [])
  })

  it('lists an unanswered thread-level review before the anchored one', () => {
    const legacy = report({ startedAt: 5 })
    const anchored = report({ startedAt: 30 })
    const t = thread({
      messages: [
        message('u1', 'user', 1),
        { ...message('a1', 'assistant', 4), reviewReport: anchored },
      ],
      reviewReport: legacy,
    })
    assert.deepEqual(reviewReportsAwaitingModel(t), [legacy, anchored])
  })
})

describe('reviewReportModelContext', () => {
  it('is absent when there is nothing to hand over', () => {
    assert.equal(reviewReportModelContext([]), undefined)
  })

  it('summarises what was reviewed and lists the open findings compactly', () => {
    const text = reviewReportModelContext([
      report({
        findings: [
          finding(),
          finding({
            id: 'b',
            path: 'src/timer.ts',
            startLine: 10,
            endLine: 14,
            severity: 'medium',
            verdict: { status: 'unverified', reason: 'r' },
            claim: 'The timer leaks.',
          }),
          finding({ id: 'c', claim: 'Dismissed claim.', dismissed: true }),
        ],
        appendix: 2,
      }),
    ])
    assert.ok(text)
    assert.ok(text.startsWith('<copse_review_report>\n'))
    assert.ok(text.endsWith('\n</copse_review_report>'))
    assert.match(text, /the user ran Copse Reviewer/)
    assert.match(text, /You did not start this review/)
    assert.match(text, /reviewed HEAD \(abc1234def\) against main with gpt-5/)
    assert.match(text, /Checks: test regressed\./)
    assert.match(text, /2 finding\(s\) \(1 more dismissed by the user and left out\):/)
    assert.match(text, /1\. \[high · contract · confirmed\] src\/math\.ts:3 — add subtracts/)
    assert.match(
      text,
      /2\. \[medium · contract · unverified\] src\/timer\.ts:10–14 — The timer leaks\./,
    )
    assert.doesNotMatch(text, /Dismissed claim/)
    assert.match(text, /2 lower-ranked finding\(s\) fell below the report's cut\./)
    // Summary and findings only: the verdict reasons, evidence and anchored
    // source stay on the card.
    assert.doesNotMatch(text, /The reproducer fails on head/)
  })

  it('says a clean review is clean and a read-only one executed nothing', () => {
    const text = reviewReportModelContext([
      report({
        findings: [],
        execution: { backend: 'host', strength: 'none', executed: false, reason: 'no OS sandbox' },
      }),
    ])
    assert.ok(text)
    assert.match(text, /Read-only review: nothing was executed \(no OS sandbox\)\./)
    assert.match(text, /No findings\./)
  })

  it('caps the findings listed and clips a runaway claim', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      finding({ id: String(i), claim: i === 0 ? 'x'.repeat(2_000) : `claim ${String(i)}` }),
    )
    const text = reviewReportModelContext([report({ findings: many })])
    assert.ok(text)
    assert.match(text, /…and 8 more on the card\./)
    assert.doesNotMatch(text, /x{500}/)
    assert.doesNotMatch(text, /claim 12\b/)
  })

  it('summarises only the latest few of many unanswered reviews', () => {
    const reports = [1, 2, 3, 4, 5].map((i) =>
      report({ startedAt: i, findings: [finding({ claim: `claim of run ${String(i)}` })] }),
    )
    const text = reviewReportModelContext(reports)
    assert.ok(text)
    assert.match(text, /ran Copse Reviewer 5 times/)
    assert.match(text, /Only the latest 3 are summarised here\./)
    assert.doesNotMatch(text, /claim of run 2/)
    assert.match(text, /claim of run 3/)
    assert.match(text, /claim of run 5/)
  })
})

describe('withReviewContext', () => {
  it('leads a text prompt with the summary and leaves it alone without one', () => {
    assert.equal(withReviewContext('fix them', '<r/>'), '<r/>\n\nfix them')
    assert.equal(withReviewContext('fix them', undefined), 'fix them')
  })

  it('makes the summary the first text part of an image prompt', () => {
    assert.deepEqual(
      withReviewContext(
        [
          { type: 'text', text: 'look' },
          { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
        ],
        '<r/>',
      ),
      [
        { type: 'text', text: '<r/>' },
        { type: 'text', text: 'look' },
        { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
      ],
    )
  })
})
