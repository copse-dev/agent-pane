import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@shared/types'
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
} from './trim-history.ts'

beforeEach(() => {
  setLastMeasuredInputTokens(null)
})

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
    assert.equal(messages[0]?.role, 'system')
    assert.match(messages[0]?.content, /keep me/)
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
    assert.equal(messages[1]?.role, 'tool')
    const results = messages[1]?.role === 'tool' ? messages[1].toolResults : []
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
