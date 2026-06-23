import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeContextBreakdown,
  CONTEXT_SEGMENT_LABELS,
  CONTEXT_SEGMENT_ORDER,
} from './context-breakdown.ts'

describe('composeContextBreakdown', () => {
  it('rounds parts, sums the total, and keeps the canonical order', () => {
    const result = composeContextBreakdown(
      { message: 10.4, system: 100.6, tools: 50, skills: 5.2 },
      200_000,
    )
    assert.deepEqual(
      result.segments.map((s) => s.key),
      ['system', 'tools', 'skills', 'message'],
    )
    assert.equal(result.segments[0]?.tokens, 101)
    assert.equal(result.segments[0]?.label, CONTEXT_SEGMENT_LABELS.system)
    assert.equal(result.totalTokens, 101 + 50 + 5 + 10)
    assert.equal(result.contextWindow, 200_000)
  })

  it('drops empty or missing parts from the segment list but keeps them at zero total weight', () => {
    const result = composeContextBreakdown({ system: 0, tools: 0, message: 8 }, 1000)
    assert.deepEqual(
      result.segments.map((s) => s.key),
      ['message'],
    )
    assert.equal(result.totalTokens, 8)
  })

  it('clamps negative values to zero', () => {
    const result = composeContextBreakdown({ system: -50, message: 12 }, -100)
    assert.deepEqual(
      result.segments.map((s) => s.key),
      ['message'],
    )
    assert.equal(result.totalTokens, 12)
    assert.equal(result.contextWindow, 0)
  })

  it('exposes a label for every ordered segment key', () => {
    for (const key of CONTEXT_SEGMENT_ORDER) {
      assert.ok(CONTEXT_SEGMENT_LABELS[key])
    }
  })
})
