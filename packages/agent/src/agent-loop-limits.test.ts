import { describe, it, mock } from 'node:test'
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
  isStreamOutputRunaway,
  MAX_STREAM_OUTPUT_TOKENS,
} from './agent-loop-limits.ts'

describe('agent-loop-limits', () => {
  it('caps max LLM calls relative to maxSteps', () => {
    assert.equal(defaultMaxLlmCallsForSteps(10), 13)
    assert.equal(defaultMaxLlmCallsForSteps(100), DEFAULT_MAX_LLM_CALLS)
  })

  it('flags a single stream as runaway only past the output-token cap', () => {
    // 4 chars/token: the cap in characters.
    const capChars = MAX_STREAM_OUTPUT_TOKENS * 4
    assert.equal(isStreamOutputRunaway(0), false)
    assert.equal(isStreamOutputRunaway(capChars - 4), false)
    assert.equal(isStreamOutputRunaway(capChars), true)
    assert.equal(isStreamOutputRunaway(capChars * 5), true)
  })

  it('honours a custom output-token cap', () => {
    assert.equal(isStreamOutputRunaway(39, 10), false)
    assert.equal(isStreamOutputRunaway(40, 10), true)
  })

  it('detects elapsed run deadline', () => {
    const start = Date.now() - 100
    // Drive the hard wall-clock cap from run start; keep the idle window wide so
    // only the hard cap decides, mirroring the old run-timeout-elapsed check.
    const expired = new AgentRunDeadline(10_000, 50, start)
    assert.equal(expired.isExpired(), true)
    const notExpired = new AgentRunDeadline(10_000, 10_000, start)
    assert.equal(notExpired.isExpired(), false)
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

  it('reports ms until the nearest expiry, clamped at zero', () => {
    const deadline = new AgentRunDeadline(1_000, 10_000, 0)
    // Idle is the binding constraint early on.
    assert.equal(deadline.msUntilExpiry(0), 1_000)
    assert.equal(deadline.msUntilExpiry(400), 600)
    deadline.recordActivity(400)
    assert.equal(deadline.msUntilExpiry(400), 1_000)
    // With activity kept fresh, the hard cap becomes the binding constraint near the end.
    deadline.recordActivity(9_800)
    assert.equal(deadline.msUntilExpiry(9_800), 200)
    // Never negative once a deadline has passed.
    assert.equal(deadline.msUntilExpiry(10_001), 0)
  })

  it('recognises only a timeout-reason abort', () => {
    assert.equal(isAgentRunTimeoutAbort(undefined), false)
    const open = new AbortController()
    assert.equal(isAgentRunTimeoutAbort(open.signal), false)
    const userStop = new AbortController()
    userStop.abort('user-stop')
    assert.equal(isAgentRunTimeoutAbort(userStop.signal), false)
    const timedOut = new AbortController()
    timedOut.abort(AGENT_RUN_ABORT_REASON_TIMEOUT)
    assert.equal(isAgentRunTimeoutAbort(timedOut.signal), true)
  })

  it('aborts immediately when the deadline is already expired at schedule time', () => {
    const controller = new AbortController()
    const deadline = new AgentRunDeadline(0, AGENT_RUN_HARD_MAX_MS)
    const scheduler = createAgentRunAbortScheduler(controller, deadline)
    scheduler.schedule()
    assert.equal(controller.signal.aborted, true)
    assert.equal(controller.signal.reason, AGENT_RUN_ABORT_REASON_TIMEOUT)
    assert.equal(isAgentRunTimeoutAbort(controller.signal), true)
    scheduler.clear()
  })

  it('arms a timer and aborts when the idle window elapses with no activity', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const controller = new AbortController()
      const deadline = new AgentRunDeadline(1_000, 60_000)
      const scheduler = createAgentRunAbortScheduler(controller, deadline)
      scheduler.schedule()
      mock.timers.tick(999)
      assert.equal(controller.signal.aborted, false)
      mock.timers.tick(1)
      assert.equal(controller.signal.aborted, true)
      assert.equal(controller.signal.reason, AGENT_RUN_ABORT_REASON_TIMEOUT)
      scheduler.clear()
    } finally {
      mock.timers.reset()
    }
  })

  it('keeps rescheduling instead of aborting while activity resets the window', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const controller = new AbortController()
      const deadline = new AgentRunDeadline(1_000, 60_000)
      const scheduler = createAgentRunAbortScheduler(controller, deadline)
      scheduler.schedule()
      // Five rounds of activity, each comfortably inside the 1s idle window.
      for (let i = 0; i < 5; i++) {
        mock.timers.tick(800)
        assert.equal(controller.signal.aborted, false)
        deadline.recordActivity()
        scheduler.schedule() // mirrors onRunDeadlineActivity re-arming the timer
      }
      // 4s of wall-clock elapsed, far past the idle window, yet still alive.
      assert.equal(controller.signal.aborted, false)
      // Once activity stops, the idle window finally elapses and aborts.
      mock.timers.tick(1_000)
      assert.equal(controller.signal.aborted, true)
      assert.equal(controller.signal.reason, AGENT_RUN_ABORT_REASON_TIMEOUT)
      scheduler.clear()
    } finally {
      mock.timers.reset()
    }
  })

  it('survives a long pause until the hard cap fires (slow tool / permission wait)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const controller = new AbortController()
      // Idle 1s, hard cap 5s. A paused operation must outlive the idle window.
      const deadline = new AgentRunDeadline(1_000, 5_000)
      const scheduler = createAgentRunAbortScheduler(controller, deadline)
      scheduler.schedule()
      deadline.pause() // a tool starts / we wait on permission approval
      // Advance well past the idle window; paused time must not count.
      for (let i = 1; i <= 4; i++) {
        mock.timers.tick(1_000)
        assert.equal(
          controller.signal.aborted,
          false,
          `must not abort at ${String(i)}s while paused`,
        )
      }
      // The hard wall-clock cap (5s) still applies and aborts.
      mock.timers.tick(1_000)
      assert.equal(controller.signal.aborted, true)
      assert.equal(controller.signal.reason, AGENT_RUN_ABORT_REASON_TIMEOUT)
      scheduler.clear()
    } finally {
      mock.timers.reset()
    }
  })
})
