import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  continuationBudgetExhaustedSummary,
  type ContinuationGrantCounts,
} from './continuation-budget-summary.ts'

const noGrants: ContinuationGrantCounts = {
  'todo-closeout': 0,
  'pre-review-todo': 0,
  'post-review-remediation': 0,
}

describe('continuationBudgetExhaustedSummary', () => {
  it('lists only remaining plan items and recorded allowance reasons', () => {
    const summary = continuationBudgetExhaustedSummary(
      [
        { id: 'a', content: 'Implement the parser', status: 'in_progress' },
        { id: 'b', content: 'Add tests', status: 'pending' },
        { id: 'c', content: 'Already done', status: 'completed' },
        { id: 'd', content: 'No longer needed', status: 'cancelled' },
      ],
      { 'todo-closeout': 3, 'pre-review-todo': 1, 'post-review-remediation': 1 },
      { remaining: 0, aborted: false, failed: false },
    )

    assert.ok(summary)
    assert.match(summary, /In progress: Implement the parser/)
    assert.match(summary, /Pending: Add tests/)
    assert.doesNotMatch(summary, /Already done|No longer needed/)
    assert.match(summary, /todo closeout: 3/)
    assert.match(summary, /pre-review plan reconciliation: 1/)
    assert.match(summary, /review remediation: 1/)
    assert.doesNotMatch(summary, /attempted|completed allowances/)
  })

  it('bounds long plan content while retaining the exact omitted count', () => {
    const todos = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      content: index === 0 ? `First ${'long '.repeat(60)}item` : `Plan item ${String(index + 1)}`,
      status: 'pending' as const,
    }))
    const summary = continuationBudgetExhaustedSummary(todos, noGrants, {
      remaining: 0,
      aborted: false,
      failed: false,
    })

    assert.ok(summary)
    assert.match(summary, /First long long/)
    assert.match(summary, /…/)
    assert.match(summary, /2 more open plan items/)
    assert.doesNotMatch(summary, /Plan item 10/)
    assert.match(summary, /already at its limit/)
  })

  it('returns no summary for a settled plan, remaining budget, abort, or failure', () => {
    const open = [{ id: 'a', content: 'Still open', status: 'pending' as const }]
    const terminal = { remaining: 0, aborted: false, failed: false }
    assert.equal(
      continuationBudgetExhaustedSummary(
        [{ id: 'a', content: 'Done', status: 'completed' }],
        noGrants,
        terminal,
      ),
      null,
    )
    assert.equal(
      continuationBudgetExhaustedSummary(open, noGrants, { ...terminal, remaining: 1 }),
      null,
    )
    assert.equal(
      continuationBudgetExhaustedSummary(open, noGrants, { ...terminal, aborted: true }),
      null,
    )
    assert.equal(
      continuationBudgetExhaustedSummary(open, noGrants, { ...terminal, failed: true }),
      null,
    )
  })
})
