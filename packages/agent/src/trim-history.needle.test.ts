// RULER-shaped needle tests for in-loop compaction (#752): build synthetic long
// threads with planted facts, trim to a budget, and assert what compaction must
// preserve — user-turn needles, the recent tail, tool_use/tool_result pairing,
// and the working-brief goal-recovery path. Deterministic: no model, no clock,
// no randomness. See docs/plans/industry-benchmarks.md, Phase 1.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  trimHistory,
  conversationTokenBudget,
  estimateConversationTokens,
  setLastMeasuredInputTokens,
} from './trim-history.ts'
import { nextWorkingBrief, resolveParentGoal } from './working-brief.ts'

const GOAL_NEEDLE = 'NEEDLE-GOAL: migrate the billing service to the v2 payments API'
const EARLY_NEEDLE = 'NEEDLE-EARLY: the legacy flag lives in config/flags.ts line 12'
const LATE_NEEDLE = 'NEEDLE-LATE: the failing spec is billing-migration.spec.ts'

/** Deterministic ~800-char filler distinct per round (no randomness, no clock). */
function filler(round: number): string {
  return `round-${String(round)} `.repeat(100)
}

/**
 * A synthetic agent thread: system prompt, one goal-bearing user turn, then
 * `rounds` assistant tool_use + tool_result pairs. The early needle is planted
 * in the first tool result, the late needle in the last one.
 */
function buildThread(rounds: number): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'You are a coding agent working in a repository.' },
    { role: 'user', content: GOAL_NEEDLE },
  ]
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { id: `call-${String(i)}`, name: 'read_file', args: { path: `src/f${String(i)}.ts` } },
      ],
    })
    const planted = i === 0 ? EARLY_NEEDLE : i === rounds - 1 ? LATE_NEEDLE : ''
    messages.push({
      role: 'tool',
      toolResults: [{ toolCallId: `call-${String(i)}`, result: `${planted}\n${filler(i)}` }],
    })
  }
  return messages
}

function containsNeedle(messages: LLMMessage[], needle: string): boolean {
  return JSON.stringify(messages).includes(needle)
}

describe('trim-history needle retention', () => {
  beforeEach(() => {
    setLastMeasuredInputTokens(null)
  })

  it('keeps user-turn needles under arbitrarily heavy trimming', () => {
    const thread = buildThread(200)
    const { messages, trimmed } = trimHistory(thread, 4_000)
    assert.equal(trimmed, true)
    assert.ok(containsNeedle(messages, GOAL_NEEDLE), 'goal user turn must survive')
    assert.equal(
      messages.filter((m) => m.role === 'user').length,
      thread.filter((m) => m.role === 'user').length,
      'no user message may be dropped',
    )
  })

  it('drops oldest-first: early tool-result needle goes, late one survives in the tail', () => {
    const { messages, trimmed } = trimHistory(buildThread(200), 4_000)
    assert.equal(trimmed, true)
    assert.ok(!containsNeedle(messages, EARLY_NEEDLE), 'oldest round is the first casualty')
    assert.ok(containsNeedle(messages, LATE_NEEDLE), 'newest rounds are protected by the tail')
  })

  it('keeps every assistant tool_use paired with tool_results after trimming', () => {
    const { messages } = trimHistory(buildThread(120), 6_000)
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
      const next = messages[i + 1]
      assert.ok(next?.role === 'tool', `assistant tool_use at ${String(i)} needs a tool message`)
      const have = new Set(next.toolResults.map((r) => r.toolCallId))
      for (const call of m.content) {
        assert.ok(have.has(call.id), `tool_use ${call.id} lost its tool_result`)
      }
    }
  })

  it('lands within the conversation budget across a context-size sweep', () => {
    for (const maxContextTokens of [2_000, 8_000, 32_000]) {
      const { messages } = trimHistory(buildThread(100), maxContextTokens)
      const budget = conversationTokenBudget(messages, maxContextTokens)
      const estimate = estimateConversationTokens(messages)
      // Either the trim fit the budget, or it stopped at the minTail floor
      // (default 5 messages; a paired drop can leave one extra).
      assert.ok(
        estimate <= budget || messages.length <= 6,
        `context ${String(maxContextTokens)}: estimate ${String(estimate)} over budget ${String(budget)} with ${String(messages.length)} messages left`,
      )
    }
  })

  it('working brief recovers the goal after heavy trimming, with and without persistence', () => {
    const thread = buildThread(200)
    const brief = nextWorkingBrief(undefined, GOAL_NEEDLE)
    const { messages } = trimHistory(thread, 4_000)
    // Persisted-brief path.
    assert.equal(resolveParentGoal(brief, messages, 'follow up'), GOAL_NEEDLE)
    // Fallback path: sound only because trimming never drops user turns.
    assert.equal(resolveParentGoal(undefined, messages, 'follow up'), GOAL_NEEDLE)
  })
})
