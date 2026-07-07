import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  estimateMessageTokens,
  trimMessagesInPlace,
  historyTokenBudget,
  repairToolUseToolResultPairing,
  CANCELLED_TOOL_RESULT,
  ESTIMATED_IMAGE_TOKENS,
  setLastMeasuredInputTokens,
  effectiveConversationTokens,
  estimateConversationTokens,
  conversationTokenBudget,
} from './trim-history.ts'

beforeEach(() => {
  setLastMeasuredInputTokens(null)
})

// Faithful copy of the pre-#583 algorithm: it re-measures the WHOLE conversation
// every iteration via effectiveConversationTokens. The precompute rewrite must
// produce byte-identical results, so this acts as the behavioral oracle.
type TrimOpts = {
  reserveTokens?: number
  minTailMessages?: number
  completionReserveTokens?: number
}

function refContentStartIndex(messages: LLMMessage[]): number {
  return messages[0]?.role === 'system' ? 1 : 0
}

function refDroppableSpan(messages: LLMMessage[], index: number): number {
  const m = messages[index]
  if (!m || m.role === 'user') return 0
  if (m.role === 'tool') {
    const prev = messages[index - 1]
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) return 0
    return 1
  }
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    const next = messages[index + 1]
    if (next?.role === 'tool') return 2
  }
  return 1
}

function refFindOldestDroppableIndex(messages: LLMMessage[], minTail: number): number {
  const start = refContentStartIndex(messages)
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.role === 'user') continue
    const span = refDroppableSpan(messages, i)
    if (span === 0) continue
    if (messages.length - span < minTail) return -1
    return i
  }
  return -1
}

function refTrimMessagesInPlace(
  messages: LLMMessage[],
  maxContextTokens: number,
  opts?: TrimOpts,
): boolean {
  const minTail = opts?.minTailMessages ?? 5
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, opts)
  let trimmed = false
  repairToolUseToolResultPairing(messages)
  while (messages.length > minTail && effectiveConversationTokens(messages) > conversationBudget) {
    const dropIndex = refFindOldestDroppableIndex(messages, minTail)
    if (dropIndex < 0) break
    const span = refDroppableSpan(messages, dropIndex)
    messages.splice(dropIndex, span)
    trimmed = true
  }
  return trimmed
}

describe('historyTokenBudget', () => {
  it('uses most of the context window minus tool and completion reserve', () => {
    assert.equal(historyTokenBudget(8192, { reserveTokens: 2500 }), 4668)
    assert.equal(historyTokenBudget(32_768, { reserveTokens: 2500 }), 29_244)
  })
})

describe('trimMessagesInPlace', () => {
  it('drops oldest non-system messages until under budget', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'a2' },
    ]
    const before = estimateMessageTokens(messages)
    const trimmed = trimMessagesInPlace(messages, 30, {
      reserveTokens: 0,
      minTailMessages: 3,
      completionReserveTokens: 0,
    })
    assert.equal(trimmed, true)
    assert.equal(messages[0]?.role, 'system')
    assert.ok(estimateMessageTokens(messages) < before)
  })

  it('keeps system prompt at index 0', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'keep me' },
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'y'.repeat(4000) },
    ]
    trimMessagesInPlace(messages, 100, { minTailMessages: 2 })
    const first = messages[0]
    assert.ok(first?.role === 'system')
    assert.match(first.content, /keep me/)
  })

  it('never drops user messages (LM Studio prompt templates need a user query)', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Can you test my code?' },
      { role: 'assistant', content: Array.from({ length: 800 }, () => 'tooly').join(' ') },
      {
        role: 'assistant',
        content: [{ id: '1', name: 'list_dir', args: { path: '.' } }],
      },
      { role: 'tool', toolResults: [{ toolCallId: '1', result: 'f package.json' }] },
    ]
    trimMessagesInPlace(messages, 50, { minTailMessages: 3, reserveTokens: 0 })
    assert.ok(messages.some((m) => m.role === 'user' && m.content === 'Can you test my code?'))
  })

  it('does not trim when only the system prompt is large', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 's'.repeat(40_000) },
      { role: 'user', content: 'run tests' },
    ]
    const trimmed = trimMessagesInPlace(messages, 15_050, {
      reserveTokens: 2_500,
      minTailMessages: 2,
    })
    assert.equal(trimmed, false)
    assert.equal(messages.length, 2)
  })

  it('drops assistant+tool pairs together when trimming', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ id: '1', name: 'list_dir', args: {} }],
      },
      { role: 'tool', toolResults: [{ toolCallId: '1', result: 'big '.repeat(500) }] },
      { role: 'assistant', content: 'summary '.repeat(500) },
    ]
    const beforeLen = messages.length
    trimMessagesInPlace(messages, 100, { minTailMessages: 2 })
    assert.ok(messages.length < beforeLen)
    const user = messages.find((m) => m.role === 'user')
    assert.equal(user?.content, 'go')
  })
})

describe('repairToolUseToolResultPairing', () => {
  it('synthesizes tool results for assistant tool_use without a tool message', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ id: 'a1', name: 'read_file', args: {} }],
      },
    ]
    repairToolUseToolResultPairing(messages)
    assert.equal(messages.length, 2)
    const second = messages[1]
    assert.ok(second?.role === 'tool')
    const results = second.toolResults
    assert.equal(results[0]?.result, CANCELLED_TOOL_RESULT)
  })

  it('fills in only the unanswered tool_use ids of an existing tool message', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { id: 'a1', name: 'read_file', args: {} },
          { id: 'a2', name: 'list_dir', args: {} },
        ],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'a1', result: 'done' }] },
    ]
    repairToolUseToolResultPairing(messages)
    assert.equal(messages.length, 2)
    const results = messages[1]?.role === 'tool' ? messages[1].toolResults : []
    assert.equal(results.length, 2)
    assert.equal(results.find((r) => r.toolCallId === 'a1')?.result, 'done')
    assert.equal(results.find((r) => r.toolCallId === 'a2')?.result, CANCELLED_TOOL_RESULT)
  })

  it('leaves fully paired tool_use/tool_result history untouched', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ id: 'a1', name: 'read_file', args: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'a1', result: 'done' }] },
    ]
    const before = JSON.stringify(messages)
    repairToolUseToolResultPairing(messages)
    assert.equal(JSON.stringify(messages), before)
  })
})

describe('effectiveConversationTokens', () => {
  it('uses measured input tokens when set', () => {
    setLastMeasuredInputTokens(null)
    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]
    assert.ok(effectiveConversationTokens(messages) < 100)
    setLastMeasuredInputTokens(50_000)
    assert.equal(effectiveConversationTokens(messages), 50_000)
    setLastMeasuredInputTokens(null)
  })

  it('counts image blocks at flat token estimate', () => {
    setLastMeasuredInputTokens(null)
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(100_000) }],
      },
    ]
    const tokens = estimateMessageTokens(messages)
    assert.ok(tokens >= ESTIMATED_IMAGE_TOKENS)
    assert.ok(tokens < 100_000 / 4)
  })

  it('excludes base64 image data from estimateConversationTokens (#53)', () => {
    setLastMeasuredInputTokens(null)
    const big = 'A'.repeat(200_000)
    const withImage: LLMMessage[] = [
      { role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,' + big }] },
    ]
    const tokens = estimateConversationTokens(withImage)
    // A 200K-char base64 image must not be counted at ~4 chars/token.
    assert.ok(tokens < 200_000 / 4)
    assert.ok(tokens >= ESTIMATED_IMAGE_TOKENS)
  })

  it('prefers measured input tokens over the estimate for trimming (#52)', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'short' }]
    setLastMeasuredInputTokens(75_000)
    assert.equal(effectiveConversationTokens(messages), 75_000)
  })
})

describe('trimMessagesInPlace precompute (#583)', () => {
  function assistantToolPair(idBase: string, size: number): LLMMessage[] {
    return [
      { role: 'assistant', content: [{ id: idBase, name: 'read_file', args: { n: idBase } }] },
      { role: 'tool', toolResults: [{ toolCallId: idBase, result: 'r'.repeat(size) }] },
    ]
  }

  function imageMessage(pixels: number): LLMMessage {
    return {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(pixels) },
      ],
    }
  }

  const fixtures = {
    plainText: (): LLMMessage[] => [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'q1 '.repeat(50) },
      { role: 'assistant', content: 'a1 '.repeat(50) },
      { role: 'user', content: 'q2 '.repeat(50) },
      { role: 'assistant', content: 'a2 '.repeat(50) },
      { role: 'user', content: 'q3 '.repeat(50) },
      { role: 'assistant', content: 'a3 '.repeat(50) },
    ],
    withToolPairs: (): LLMMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do stuff' },
      ...assistantToolPair('t1', 400),
      { role: 'assistant', content: 'thinking '.repeat(80) },
      ...assistantToolPair('t2', 400),
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'done '.repeat(80) },
    ],
    withImages: (): LLMMessage[] => [
      { role: 'system', content: 'sys' },
      imageMessage(30_000),
      { role: 'assistant', content: 'a '.repeat(60) },
      imageMessage(30_000),
      { role: 'assistant', content: 'b '.repeat(60) },
      { role: 'user', content: 'final question' },
      { role: 'assistant', content: 'c '.repeat(60) },
    ],
    noSystemPrompt: (): LLMMessage[] => [
      { role: 'user', content: 'hello '.repeat(40) },
      { role: 'assistant', content: 'world '.repeat(40) },
      { role: 'user', content: 'again '.repeat(40) },
      { role: 'assistant', content: 'reply '.repeat(40) },
      { role: 'user', content: 'more '.repeat(40) },
      { role: 'assistant', content: 'ok '.repeat(40) },
    ],
    danglingToolUse: (): LLMMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ id: 'x1', name: 'ls', args: {} }] },
      { role: 'assistant', content: 'summary '.repeat(70) },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'welcome '.repeat(70) },
    ],
  }

  const budgets = [30, 80, 150, 400, 1_000, 5_000]
  const tailSizes = [2, 3, 5]

  for (const [name, build] of Object.entries(fixtures)) {
    for (const budget of budgets) {
      for (const minTailMessages of tailSizes) {
        it(`matches the recompute oracle: ${name} budget=${String(budget)} minTail=${String(minTailMessages)}`, () => {
          const opts = { reserveTokens: 0, completionReserveTokens: 0, minTailMessages }
          const actual = build()
          const expected = build()
          const actualTrimmed = trimMessagesInPlace(actual, budget, opts)
          const expectedTrimmed = refTrimMessagesInPlace(expected, budget, opts)
          assert.equal(actualTrimmed, expectedTrimmed)
          assert.equal(JSON.stringify(actual), JSON.stringify(expected))
        })
      }
    }
  }

  it('stops once a full recompute confirms the survivors fit (no drift from subtraction)', () => {
    // After trimming, the surviving conversation measured by a fresh full-array
    // recompute must fit the budget, unless nothing droppable remains — proving the
    // running subtraction never let the loop stop early or trim one message too many.
    const messages = fixtures.plainText()
    const opts = { reserveTokens: 0, completionReserveTokens: 0, minTailMessages: 3 }
    trimMessagesInPlace(messages, 120, opts)
    const recomputed = estimateConversationTokens(messages)
    const budget = conversationTokenBudget(messages, 120, opts)
    const noneDroppable = refFindOldestDroppableIndex(messages, opts.minTailMessages) < 0
    assert.ok(recomputed <= budget || noneDroppable)
  })

  it('measured input tokens stay constant across drops (does not use precompute total)', () => {
    // With a measured size far above budget, trimming must proceed down to minTail
    // exactly as the pre-#583 code did, ignoring per-message estimates entirely.
    const withMeasured = fixtures.plainText()
    const withoutMeasured = fixtures.plainText()
    setLastMeasuredInputTokens(500_000)
    const trimmedMeasured = trimMessagesInPlace(withMeasured, 1_000, {
      reserveTokens: 0,
      completionReserveTokens: 0,
      minTailMessages: 3,
    })
    setLastMeasuredInputTokens(500_000)
    const refMeasured = refTrimMessagesInPlace(withoutMeasured, 1_000, {
      reserveTokens: 0,
      completionReserveTokens: 0,
      minTailMessages: 3,
    })
    setLastMeasuredInputTokens(null)
    assert.equal(trimmedMeasured, refMeasured)
    assert.equal(JSON.stringify(withMeasured), JSON.stringify(withoutMeasured))
    // The constant measured size never shrinks, so trimming drops every droppable
    // message it can rather than stopping once a shrinking estimate fit the budget.
    assert.ok(withMeasured.length < fixtures.plainText().length)
    assert.equal(refFindOldestDroppableIndex(withMeasured, 3), -1)
  })

  it('does not collapse to minTail when measured tokens only slightly exceed budget (#717)', () => {
    // Realistic case: the provider-measured size roughly equals the estimated
    // content, and the budget sits just under it. The trim must drop only the
    // oldest few spans it needs — not everything down to minTail. Before the fix,
    // the measured baseline never shrank, so one pass wiped the whole history.
    const messages: LLMMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: 'q'.repeat(400) })
      messages.push({ role: 'assistant', content: 'a'.repeat(400) })
    }
    const lengthBefore = messages.length
    const estimated = estimateConversationTokens(messages)
    setLastMeasuredInputTokens(Math.round(estimated))
    const maxContextTokens = Math.round(estimated * 0.9) // ~10% over → a few spans

    const trimmed = trimMessagesInPlace(messages, maxContextTokens, {
      reserveTokens: 0,
      minTailMessages: 5,
      completionReserveTokens: 0,
    })
    setLastMeasuredInputTokens(null)

    assert.equal(trimmed, true)
    // The regression would leave ~minTail (5-6). The fix keeps the large majority.
    assert.ok(
      messages.length >= 25,
      `expected a small trim, only ${String(messages.length)} of ${String(lengthBefore)} left`,
    )
  })
})
