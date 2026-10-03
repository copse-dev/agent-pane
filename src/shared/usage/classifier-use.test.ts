import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DecisionEvent } from '@shared/threads/decision-log.ts'
import { CLASSIFIER_CALL_KIND, summarizeClassifierUse } from './classifier-use.ts'

function call(overrides: Partial<DecisionEvent>): DecisionEvent {
  return {
    v: 1,
    type: 'decision',
    id: 'id',
    at: 1,
    kind: CLASSIFIER_CALL_KIND,
    actor: 'classifier',
    verdict: 'classified',
    subject: 'shell-scope',
    source: 'Kev 4B',
    ...overrides,
  }
}

describe('summarizeClassifierUse', () => {
  it('is empty for a thread with no classifier calls', () => {
    assert.deepEqual(summarizeClassifierUse([]), { calls: 0, rows: [] })
    // Permission-oriented classification lines are not calls: counting them
    // would report one screening twice.
    assert.deepEqual(summarizeClassifierUse([call({ kind: 'classification' })]), {
      calls: 0,
      rows: [],
    })
  })

  it('tallies verdicts, tokens and mean latency per subject and engine', () => {
    const use = summarizeClassifierUse([
      call({ scope: 'sandbox', latencyMs: 800, inputTokens: 10, outputTokens: 2 }),
      call({ scope: 'sandbox', latencyMs: 1000, inputTokens: 10, outputTokens: 2 }),
      call({ scope: 'external', latencyMs: 1200 }),
      call({ verdict: 'ask' }),
    ])
    assert.equal(use.calls, 4)
    assert.equal(use.rows.length, 1)
    const [row] = use.rows
    assert.equal(row?.calls, 4)
    assert.deepEqual(row.verdicts, [
      { label: 'sandbox', count: 2 },
      { label: 'external', count: 1 },
    ])
    assert.equal(row.noVerdict, 1)
    // The call that reported no latency does not drag the mean down.
    assert.equal(row.averageLatencyMs, 1000)
    assert.equal(row.inputTokens, 20)
    assert.equal(row.outputTokens, 4)
  })

  it('keeps separate engines and subjects apart, busiest first', () => {
    const use = summarizeClassifierUse([
      call({ subject: 'terminal-read', source: 'Winnow 12B', scope: 'safe' }),
      call({ scope: 'sandbox' }),
      call({ scope: 'sandbox' }),
      call({ scope: 'sandbox', source: 'Reflex 4B' }),
    ])
    assert.deepEqual(
      use.rows.map((row) => [row.subject, row.engine, row.calls]),
      [
        ['shell-scope', 'Kev 4B', 2],
        ['shell-scope', 'Reflex 4B', 1],
        ['terminal-read', 'Winnow 12B', 1],
      ],
    )
  })

  it('reports no mean latency when no call recorded one', () => {
    const [row] = summarizeClassifierUse([call({ scope: 'sandbox' })]).rows
    assert.equal(row?.averageLatencyMs, null)
  })

  it('ignores a subject from a newer build', () => {
    assert.deepEqual(summarizeClassifierUse([call({ subject: 'something-new' })]), {
      calls: 0,
      rows: [],
    })
  })
})
