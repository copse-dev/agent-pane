import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewFindingRecord, ThreadReviewReport } from '@shared/types'
import { createReviewFindingsCardEl, findingLocation } from './review-findings-card.ts'

const confirmed: ReviewFindingRecord = {
  id: '0123456789abcdef',
  path: 'src/math.ts',
  startLine: 3,
  endLine: 3,
  claim: 'add subtracts its second argument instead of adding it.',
  class: 'contract',
  severity: 'high',
  confidence: 'high',
  verdict: { status: 'confirmed', reason: 'The reproducer fails on head and passes on base.' },
  raisedBy: ['gpt-5 (correctness)'],
  corroboratedBy: ['claude-opus-4-8 (contracts)'],
  challengedBy: [],
  evidence: [
    {
      kind: 'reproducer',
      testPath: '.copse-review/add.test.cjs',
      failsOnHead: true,
      passesOnBase: true,
    },
    {
      kind: 'command',
      command: 'node .copse-review/add.test.cjs',
      target: 'head',
      exitCode: 1,
      excerpt: 'AssertionError: 3 !== -1',
    },
  ],
  anchoredText: 'export const add = (a: number, b: number): number => a - b',
}

const survived: ReviewFindingRecord = {
  id: 'fedcba9876543210',
  path: 'src/timer.ts',
  startLine: 10,
  endLine: 14,
  claim: 'The timeout is never cleared when the promise rejects.',
  class: 'resource',
  severity: 'medium',
  confidence: 'medium',
  verdict: {
    status: 'unverified',
    reason: 'Survived challenge: the rejection path skips clearTimeout.',
  },
  raisedBy: ['gpt-5 (correctness)'],
  corroboratedBy: [],
  challengedBy: ['claude-opus-4-8'],
  evidence: [{ kind: 'citation', path: 'src/timer.ts', startLine: 10, endLine: 14 }],
}

const dismissed: ReviewFindingRecord = {
  ...survived,
  id: '1111222233334444',
  path: 'src/format.ts',
  claim: 'A stale comment describes the old return type.',
  severity: 'low',
  dismissed: true,
}

function report(overrides: Partial<ThreadReviewReport> = {}): ThreadReviewReport {
  return {
    status: 'done',
    startedAt: 1,
    models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
    lenses: ['correctness'],
    baseRef: 'HEAD',
    headCommit: 'abc123',
    dirtyWorkingTree: true,
    execution: { backend: 'os-sandbox', strength: 'os-sandbox', executed: true, reason: '' },
    checks: [
      { kind: 'build', verdict: 'clean' },
      { kind: 'typecheck', verdict: 'clean' },
      { kind: 'test', verdict: 'regressed' },
    ],
    notChecked: ['lint: timed out on head'],
    findings: [confirmed, survived, dismissed],
    appendix: 2,
    refuted: 1,
    reviewers: [],
    verification: {
      attempted: 3,
      confirmed: 1,
      refuted: 1,
      survived: 1,
      undetermined: 0,
      skipped: 0,
    },
    durationMs: 12_000,
    cost: '~$0.03',
    ...overrides,
  }
}

function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent)
}

describe('review findings card', () => {
  it('ranks the visible findings with severity, class, location, claim and verdict', () => {
    const card = createReviewFindingsCardEl(report())
    assert.equal(card.getAttribute('data-status'), 'done')
    assert.equal(card.querySelector('.review-report-title')?.textContent, 'Review')
    assert.match(
      card.querySelector('.review-report-meta')?.textContent ?? '',
      /gpt-5, challenged by claude-opus-4-8 · working tree against HEAD/,
    )
    assert.equal(card.querySelector('.review-report-cost')?.textContent, '~$0.03')

    const rows = [
      ...card.querySelectorAll(
        '.review-report-findings:not(.review-report-dismissed) .review-finding',
      ),
    ]
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-finding-id')),
      [confirmed.id, survived.id],
    )
    const first = rows[0]
    assert.ok(first)
    assert.equal(first.getAttribute('data-severity'), 'high')
    assert.equal(first.getAttribute('data-verdict'), 'confirmed')
    assert.equal(first.querySelector('.review-finding-severity')?.textContent, 'high')
    assert.equal(first.querySelector('.review-finding-class')?.textContent, 'contract')
    assert.equal(first.querySelector('.review-finding-location')?.textContent, 'src/math.ts:3')
    assert.equal(first.querySelector('.review-finding-claim')?.textContent, confirmed.claim)
    assert.equal(
      first.querySelector('.review-finding-verdict')?.textContent,
      'confirmed by reproducer',
    )
    const second = rows[1]
    assert.ok(second)
    assert.equal(second.querySelector('.review-finding-verdict')?.textContent, 'survived challenge')
    assert.equal(
      second.querySelector('.review-finding-location')?.textContent,
      'src/timer.ts:10–14',
    )
  })

  it('expands a finding to its reason, anchored source, evidence and provenance', () => {
    const card = createReviewFindingsCardEl(report())
    const first = card.querySelector(`[data-finding-id="${confirmed.id}"]`)
    assert.ok(first)
    assert.ok(first.querySelector('details'), 'each finding is a disclosure')
    assert.equal(
      first.querySelector('.review-finding-reason')?.textContent,
      confirmed.verdict.reason,
    )
    assert.equal(first.querySelector('.review-finding-anchor')?.textContent, confirmed.anchoredText)
    assert.deepEqual(
      [...first.querySelectorAll('.review-finding-evidence')].map((node) =>
        node.getAttribute('data-kind'),
      ),
      ['reproducer', 'command'],
    )
    assert.match(
      texts(first, '.review-finding-evidence').join('\n'),
      /reproducer fails on head, passes on base/,
    )
    assert.match(texts(first, '.review-finding-evidence').join('\n'), /on head, exit 1/)
    assert.equal(
      first.querySelector('.review-finding-excerpt')?.textContent,
      'AssertionError: 3 !== -1',
    )
    assert.equal(
      first.querySelector('.review-finding-provenance')?.textContent,
      'Raised by gpt-5 (correctness); corroborated by claude-opus-4-8 (contracts).',
    )
    assert.match(
      first.querySelector('.review-finding-confidence')?.textContent ?? '',
      /high confidence/,
    )
  })

  it('shows the Stage 0 ground as chips, including what was not checked', () => {
    const card = createReviewFindingsCardEl(report())
    assert.deepEqual(texts(card, '.review-report-check'), [
      'build ✓ clean',
      'typecheck ✓ clean',
      'test ✗ regressed',
    ])
    assert.deepEqual(texts(card, '.review-report-ground-note'), [
      'not checked: lint: timed out on head',
    ])
  })

  it('says a read-only review executed nothing, and why', () => {
    const card = createReviewFindingsCardEl(
      report({
        execution: {
          backend: 'host-process',
          strength: 'none',
          executed: false,
          reason: 'no OS sandbox is active',
        },
        checks: [],
        notChecked: [],
      }),
    )
    const note = card.querySelector('.review-report-ground-note[data-executed="false"]')
    assert.ok(note)
    assert.match(note.textContent, /Read-only review — nothing was executed: no OS sandbox/)
    assert.equal(card.querySelectorAll('.review-report-check').length, 0)
  })

  it('offers Dismiss on a live finding and Restore on a dismissed one, behind a toggle', () => {
    const dismissedIds: string[] = []
    const restoredIds: string[] = []
    const card = createReviewFindingsCardEl(report(), {
      onDismissFinding: (finding) => dismissedIds.push(finding.id),
      onRestoreFinding: (finding) => restoredIds.push(finding.id),
    })
    const dismissButton = card.querySelector<HTMLButtonElement>(
      `[data-finding-id="${confirmed.id}"] .review-finding-dismiss`,
    )
    assert.ok(dismissButton)
    dismissButton.click()
    assert.deepEqual(dismissedIds, [confirmed.id])
    assert.equal(dismissButton.disabled, true, 'a second click cannot dispatch twice')

    const dismissedList = card.querySelector<HTMLElement>('.review-report-dismissed')
    assert.ok(dismissedList)
    assert.equal(dismissedList.hidden, true, 'dismissed findings start hidden')
    const toggle = card.querySelector<HTMLButtonElement>('.review-report-dismissed-toggle')
    assert.ok(toggle)
    assert.equal(toggle.textContent, '1 dismissed')
    toggle.click()
    assert.equal(dismissedList.hidden, false)
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    const row = dismissedList.querySelector(`[data-finding-id="${dismissed.id}"]`)
    assert.ok(row)
    assert.ok(row.hasAttribute('data-dismissed'))
    assert.equal(row.querySelector('.review-finding-dismiss'), null)
    const restore = row.querySelector<HTMLButtonElement>('.review-finding-restore')
    assert.ok(restore)
    restore.click()
    assert.deepEqual(restoredIds, [dismissed.id])
  })

  it('counts the appendix and refuted findings in the footer', () => {
    const card = createReviewFindingsCardEl(report())
    assert.match(
      card.querySelector('.review-report-footer')?.textContent ?? '',
      /2 more below the cut/,
    )
    assert.match(
      card.querySelector('.review-report-footer')?.textContent ?? '',
      /1 refuted by the challenger/,
    )
  })

  it('is one line when the review is clean', () => {
    const card = createReviewFindingsCardEl(
      report({ findings: [], appendix: 0, refuted: 0, verification: null }),
    )
    assert.equal(card.querySelector('.review-report-clean')?.textContent, 'Clean.')
    assert.equal(card.querySelector('.review-report-findings'), null)
    assert.equal(card.querySelector('.review-report-footer'), null)
  })

  it('carries a note in place of "Clean." when there was nothing to review', () => {
    const card = createReviewFindingsCardEl(
      report({ findings: [], appendix: 0, refuted: 0, note: 'No changes against main.' }),
    )
    assert.equal(
      card.querySelector('.review-report-clean')?.textContent,
      'No changes against main.',
    )
  })

  it('shows only the header while the review is running', () => {
    const card = createReviewFindingsCardEl(report({ status: 'running', findings: [] }))
    assert.match(card.querySelector('.review-report-title')?.textContent ?? '', /Reviewing/)
    assert.equal(card.querySelector('.review-report-findings'), null)
    assert.equal(card.querySelector('.review-report-ground'), null)
  })

  it('offers retry and dismiss on a failed review', () => {
    let retried = 0
    let dismissedCard = 0
    const card = createReviewFindingsCardEl(
      report({ status: 'error', findings: [], error: 'Review cancelled.' }),
      {
        onRetry: () => {
          retried += 1
        },
        onDismissCard: () => {
          dismissedCard += 1
        },
      },
    )
    assert.equal(card.querySelector('.review-report-title')?.textContent, 'Review failed')
    assert.equal(card.querySelector('.review-report-error')?.textContent, 'Review cancelled.')
    card.querySelector<HTMLButtonElement>('.card-retry-button')?.click()
    card.querySelector<HTMLButtonElement>('.card-dismiss-button')?.click()
    assert.equal(retried, 1)
    assert.equal(dismissedCard, 1)
  })

  it('formats locations with and without lines', () => {
    const { startLine: _start, endLine: _end, ...unanchored } = survived
    assert.equal(findingLocation(unanchored), 'src/timer.ts')
    const { endLine: _endOnly, ...singleLine } = survived
    assert.equal(findingLocation(singleLine), 'src/timer.ts:10')
    assert.equal(findingLocation(survived), 'src/timer.ts:10–14')
  })
})
