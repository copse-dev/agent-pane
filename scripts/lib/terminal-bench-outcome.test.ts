import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { terminalBenchTrialOutcome } from './terminal-bench-outcome.mts'

describe('terminalBenchTrialOutcome', () => {
  it('treats a verifier reward as a pass even when cleanup records an agent timeout', () => {
    assert.equal(
      terminalBenchTrialOutcome({
        reward: 1,
        exceptionType: 'AgentTimeoutError',
      }),
      'pass',
    )
  })

  it('classifies agent timeouts without a reward as timeout', () => {
    assert.equal(
      terminalBenchTrialOutcome({
        reward: 0,
        exceptionType: 'AgentTimeoutError',
      }),
      'timeout',
    )
    assert.equal(
      terminalBenchTrialOutcome({
        reward: undefined,
        exceptionType: 'AgentTimeoutError',
      }),
      'timeout',
    )
  })

  it('classifies other exceptions as invalid and reward-less completions as zero', () => {
    assert.equal(
      terminalBenchTrialOutcome({
        reward: undefined,
        exceptionType: 'RuntimeError',
      }),
      'invalid',
    )
    assert.equal(
      terminalBenchTrialOutcome({
        reward: 0,
        exceptionType: undefined,
      }),
      'zero',
    )
    assert.equal(
      terminalBenchTrialOutcome({
        reward: 1,
        exceptionType: undefined,
      }),
      'pass',
    )
  })
})
