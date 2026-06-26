import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentRunDeadline,
  AGENT_RUN_ABORT_REASON_TIMEOUT,
  AGENT_RUN_HARD_MAX_MS,
  AGENT_RUN_IDLE_TIMEOUT_MS,
  createAgentRunAbortScheduler,
  defaultMaxLlmCallsForSteps,
  DEFAULT_MAX_LLM_CALLS,
  isAgentRunTimeoutAbort,
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

  it('resets the idle window on activity', () => {
    const start = 1_000
    const deadline = new AgentRunDeadline(100, AGENT_RUN_HARD_MAX_MS, start)
    assert.equal(deadline.isIdleExpired(start + 50), false)
    deadline.recordActivity(start + 50)
    assert.equal(deadline.isIdleExpired(start + 120), false)
    assert.equal(deadline.isIdleExpired(start + 151), true)
  })

  it('does not count paused time toward the idle window', () => {
    const start = 1_000
    const deadline = new AgentRunDeadline(100, AGENT_RUN_HARD_MAX_MS, start)
    deadline.pause(start + 10)
    deadline.resume(start + 90)
    assert.equal(deadline.isIdleExpired(start + 120), false)
    assert.equal(deadline.isIdleExpired(start + 201), true)
  })

  it('enforces the hard wall-clock cap regardless of activity', () => {
    const start = 1_000
    const deadline = new AgentRunDeadline(AGENT_RUN_IDLE_TIMEOUT_MS, 200, start)
    deadline.recordActivity(start + 50)
    deadline.recordActivity(start + 100)
    assert.equal(deadline.isHardExpired(start + 199), false)
    assert.equal(deadline.isExpired(start + 201), true)
  })

  it('schedules abort with the timeout reason', () => {
    const controller = new AbortController()
    const deadline = new AgentRunDeadline(0, AGENT_RUN_HARD_MAX_MS)
    const scheduler = createAgentRunAbortScheduler(controller, deadline)
    scheduler.schedule()
    assert.equal(controller.signal.aborted, true)
    assert.equal(controller.signal.reason, AGENT_RUN_ABORT_REASON_TIMEOUT)
    assert.equal(isAgentRunTimeoutAbort(controller.signal), true)
    scheduler.clear()
  })
})
