import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultMaxLlmCallsForSteps,
  DEFAULT_MAX_LLM_CALLS,
  isRunPastDeadline,
} from './agent-loop-limits.ts'

describe('agent-loop-limits', () => {
  it('caps max LLM calls relative to maxSteps', () => {
    assert.equal(defaultMaxLlmCallsForSteps(10), 13)
    assert.equal(defaultMaxLlmCallsForSteps(100), DEFAULT_MAX_LLM_CALLS)
  })

  it('detects elapsed run deadline', () => {
    const start = Date.now() - 100
    assert.equal(isRunPastDeadline(start, 50), true)
    assert.equal(isRunPastDeadline(start, 10_000), false)
  })
})
