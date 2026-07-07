import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  escalationThresholds,
  measureConversationPressure,
  shouldForceTextAnswer,
  shouldInjectLoopNudge,
} from './agent-loop-escalation.ts'

const sys: LLMMessage = { role: 'system', content: 'system prompt' }

describe('escalationThresholds', () => {
  it('scales with conversation budget', () => {
    const small = escalationThresholds(5000)
    const large = escalationThresholds(80_000)
    assert.ok(large.softNudgeMinToolSteps > small.softNudgeMinToolSteps)
    assert.ok(large.forceTextMinToolSteps > small.forceTextMinToolSteps)
  })
})

describe('shouldInjectLoopNudge', () => {
  it('fires after history was trimmed and conversation is under pressure', () => {
    const input = {
      messages: [sys, { role: 'user' as const, content: 'hi' }],
      maxContextTokens: 8192,
      toolSchemaReserveTokens: 2500,
      toolOnlySteps: 2,
      trimEvents: 1,
    }
    assert.equal(shouldInjectLoopNudge(input), false)
    const heavy = {
      ...input,
      messages: [sys, { role: 'user' as const, content: 'x'.repeat(12_000) }],
      toolOnlySteps: 3,
      trimEvents: 1,
    }
    assert.equal(shouldInjectLoopNudge(heavy), true)
  })

  it('fires when conversation fill is high', () => {
    const messages: LLMMessage[] = [
      sys,
      { role: 'user', content: 'x'.repeat(20_000) },
      { role: 'assistant', content: 'y'.repeat(20_000) },
    ]
    const input = {
      messages,
      maxContextTokens: 8192,
      toolSchemaReserveTokens: 2500,
      toolOnlySteps: 2,
      trimEvents: 0,
    }
    assert.equal(shouldInjectLoopNudge(input), true)
  })
})

describe('shouldForceTextAnswer', () => {
  it('does not force text on high fill alone after one tool round', () => {
    const messages: LLMMessage[] = [
      sys,
      { role: 'user', content: 'x'.repeat(20_000) },
      { role: 'assistant', content: 'y'.repeat(20_000) },
    ]
    const input = {
      messages,
      maxContextTokens: 8192,
      toolSchemaReserveTokens: 2500,
      toolOnlySteps: 1,
      trimEvents: 0,
    }
    assert.equal(shouldForceTextAnswer(input), false)
  })

  it('forces text when trim and fill indicate a stuck run', () => {
    const input = {
      messages: [
        sys,
        { role: 'user' as const, content: 'x'.repeat(24_000) },
        { role: 'assistant' as const, content: 'y'.repeat(24_000) },
      ],
      maxContextTokens: 15_050,
      toolSchemaReserveTokens: 2500,
      toolOnlySteps: 3,
      trimEvents: 2,
    }
    assert.equal(shouldForceTextAnswer(input), true)
  })
})

describe('measureConversationPressure', () => {
  it('returns fill ratio under 1 for a small thread', () => {
    const p = measureConversationPressure({
      messages: [sys, { role: 'user', content: 'hello' }],
      maxContextTokens: 15_050,
      toolSchemaReserveTokens: 2500,
      toolOnlySteps: 0,
      trimEvents: 0,
    })
    assert.ok(p.fillRatio < 0.2)
    assert.ok(p.conversationBudget > 0)
  })
})
