import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TurnOutcome } from '@shared/types'
import { countTokens, failedTurn, newTokenTally, tokensUsed } from './guest-turn.ts'

const outcome = (
  status: 'completed' | 'failed' | 'cancelled',
  extra: Partial<TurnOutcome> = {},
): TurnOutcome => ({
  status,
  stopReason: status === 'failed' ? 'error' : 'end_turn',
  source: 'provider',
  executor: 'acp',
  provider: 'codex-acp',
  model: 'acp:codex-acp',
  endedAt: 1,
  ...extra,
})

describe('failedTurn', () => {
  it("names the failure from the outcome's error, or its stop reason", () => {
    assert.equal(
      failedTurn(outcome('failed', { error: { message: 'authentication failed' } })),
      'authentication failed',
    )
    assert.equal(
      failedTurn(outcome('failed', { rawStopReason: 'refusal' })),
      "the agent's turn failed (refusal)",
    )
    assert.equal(failedTurn(outcome('failed')), "the agent's turn failed (error)")
  })

  it('is silent for a turn that completed, was cancelled, or recorded no outcome', () => {
    assert.equal(failedTurn(outcome('completed')), null)
    assert.equal(failedTurn(outcome('cancelled')), null)
    assert.equal(failedTurn(undefined), null)
  })
})

describe('token tally', () => {
  it("sums usage, and the agent's context reports as the input each call cost", () => {
    const tally = newTokenTally()
    countTokens(tally, { type: 'usage', model: 'm', inputTokens: 100, outputTokens: 20 })
    countTokens(tally, { type: 'usage', model: 'm', inputTokens: 50, outputTokens: 5 })
    assert.equal(tokensUsed(tally), 175)
    const pressure = (conversationTokens: number, agentReported: boolean): void => {
      countTokens(tally, {
        type: 'context_pressure',
        contextWindow: 1_000,
        conversationBudget: 1_000,
        conversationTokens,
        fillRatio: conversationTokens / 1_000,
        ...(agentReported ? { source: 'agent-reported' } : {}),
      })
    }
    pressure(900, false)
    assert.equal(tokensUsed(tally), 175, "Copse's own estimate is not the agent's word")
    // Four calls on a growing context: what they cost is their sum, not the
    // largest of them — a ceiling of 100k has to stop 40k+45k+50k+55k.
    pressure(40_000, true)
    pressure(45_000, true)
    pressure(45_000, true)
    assert.equal(tokensUsed(tally), 85_000, 'a repeated report is the same call again')
    pressure(50_000, true)
    pressure(55_000, true)
    assert.equal(tokensUsed(tally), 190_000)
    pressure(20_000, true)
    assert.equal(tokensUsed(tally), 210_000, 'a call after compaction still costs its context')
  })
})
