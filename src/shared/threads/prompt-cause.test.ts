import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_CAUSES,
  isPromptCause,
  promptCauseContainment,
  promptCauseLabel,
  summarizePromptCauses,
  type PromptCause,
} from './prompt-cause.ts'
import { makeDecisionEvent, parseDecisionLine, serializeDecisionLine } from './decision-log.ts'

describe('isPromptCause', () => {
  it('accepts every enumerated cause', () => {
    for (const cause of PROMPT_CAUSES) assert.equal(isPromptCause(cause), true)
  })

  it('rejects unknown strings and non-strings', () => {
    for (const value of ['', 'shell', 'SHELL-IN-SANDBOX', 'shell-in-sandbox ', 'unknown-cause']) {
      assert.equal(isPromptCause(value), false)
    }
    for (const value of [undefined, null, 0, 1, {}, [], Symbol('shell-in-sandbox')]) {
      assert.equal(isPromptCause(value), false)
    }
  })

  it('narrows to PromptCause when it passes', () => {
    const value: unknown = 'shell-sandbox-escalation'
    assert.equal(isPromptCause(value), true)
    if (!isPromptCause(value)) throw new Error('expected the predicate to narrow')
    // Assignable only if the predicate narrowed; a compile-time claim, checked here.
    const narrowed: PromptCause = value
    assert.equal(narrowed, 'shell-sandbox-escalation')
  })
})

describe('cause metadata', () => {
  it('classifies and labels every cause', () => {
    for (const cause of PROMPT_CAUSES) {
      assert.ok(['removed', 'kept', 'mixed'].includes(promptCauseContainment(cause)))
      assert.ok(promptCauseLabel(cause).length > 0)
    }
  })

  it('has no duplicate slugs or labels', () => {
    assert.equal(new Set(PROMPT_CAUSES).size, PROMPT_CAUSES.length)
    const labels = PROMPT_CAUSES.map(promptCauseLabel)
    assert.equal(new Set(labels).size, labels.length)
  })

  it('treats sandbox escalation as removable and an outward write as not', () => {
    assert.equal(promptCauseContainment('shell-sandbox-escalation'), 'removed')
    assert.equal(promptCauseContainment('shell-no-containment'), 'removed')
    assert.equal(promptCauseContainment('github-write'), 'kept')
    assert.equal(promptCauseContainment('web-origin'), 'kept')
    // Neither side can claim these; they must stay visibly separate.
    assert.equal(promptCauseContainment('mcp-tool'), 'mixed')
    assert.equal(promptCauseContainment('shell-guarded-yolo-harm'), 'mixed')
  })
})

describe('summarizePromptCauses', () => {
  it('counts only prompts, not non-interactive policy verdicts', () => {
    const summary = summarizePromptCauses([
      { verdict: 'approved', cause: 'shell-sandbox-escalation' },
      { verdict: 'denied', cause: 'shell-sandbox-escalation' },
      // Auto-approved and hook-blocked decisions never interrupted anyone.
      { verdict: 'allowed', cause: 'shell-sandbox-escalation' },
      { verdict: 'blocked', cause: 'github-write' },
      { verdict: 'classified' },
    ])
    assert.equal(summary.total, 2)
    assert.equal(summary.rows.length, 1)
    assert.deepEqual(summary.rows[0], {
      cause: 'shell-sandbox-escalation',
      containment: 'removed',
      total: 2,
      approved: 1,
      denied: 1,
      unresolved: 0,
    })
  })

  it('splits totals by containment', () => {
    const summary = summarizePromptCauses([
      { verdict: 'approved', cause: 'shell-sandbox-escalation' },
      { verdict: 'approved', cause: 'shell-no-containment' },
      { verdict: 'denied', cause: 'github-write' },
      { verdict: 'approved', cause: 'mcp-tool' },
    ])
    assert.deepEqual(summary.byContainment, { removed: 2, kept: 1, mixed: 1 })
  })

  it('counts timeouts and cancellations as unresolved prompts', () => {
    const summary = summarizePromptCauses([
      { verdict: 'timeout', cause: 'web-origin' },
      { verdict: 'cancelled', cause: 'web-origin' },
    ])
    assert.equal(summary.total, 2)
    assert.deepEqual(summary.rows[0], {
      cause: 'web-origin',
      containment: 'kept',
      total: 2,
      approved: 0,
      denied: 0,
      unresolved: 2,
    })
  })

  it('reports uncaused prompts separately rather than guessing', () => {
    const summary = summarizePromptCauses([
      { verdict: 'approved' },
      { verdict: 'denied', cause: 'not-a-cause' },
      { verdict: 'approved', cause: 'web-origin' },
    ])
    assert.equal(summary.uncaused, 2)
    assert.equal(summary.total, 1)
    assert.deepEqual(summary.byContainment, { removed: 0, kept: 1, mixed: 0 })
  })

  it('orders rows by frequency then slug, stably', () => {
    const summary = summarizePromptCauses([
      { verdict: 'approved', cause: 'web-origin' },
      { verdict: 'approved', cause: 'github-write' },
      { verdict: 'approved', cause: 'mcp-tool' },
      { verdict: 'approved', cause: 'mcp-tool' },
    ])
    assert.deepEqual(
      summary.rows.map((row) => row.cause),
      ['mcp-tool', 'github-write', 'web-origin'],
    )
  })

  it('is empty for an empty log', () => {
    assert.deepEqual(summarizePromptCauses([]), {
      total: 0,
      rows: [],
      byContainment: { removed: 0, kept: 0, mixed: 0 },
      uncaused: 0,
    })
  })
})

describe('decision-log round trip', () => {
  it('persists a cause through serialize and parse', () => {
    const event = makeDecisionEvent(
      {
        kind: 'shell',
        actor: 'user',
        verdict: 'approved',
        subject: 'shell command (arguments omitted)',
        cause: 'shell-sandbox-escalation',
      },
      'id-1',
      1,
    )
    assert.equal(parseDecisionLine(serializeDecisionLine(event))?.cause, 'shell-sandbox-escalation')
  })

  it('omits the field entirely when no cause is supplied', () => {
    const event = makeDecisionEvent(
      { kind: 'shell', actor: 'classifier', verdict: 'allowed', subject: 'x' },
      'id-2',
      1,
    )
    assert.equal('cause' in event, false)
    assert.equal(serializeDecisionLine(event).includes('cause'), false)
  })

  it('drops an unrecognised cause instead of rejecting the line', () => {
    const line = JSON.stringify({
      v: 1,
      type: 'decision',
      id: 'id-3',
      at: 1,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'x',
      cause: 'cause-from-a-newer-build',
    })
    const parsed = parseDecisionLine(line)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.cause, undefined)
  })
})
