import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@shared/types'
import { estimateMessageTokens, trimMessagesInPlace, historyTokenBudget } from './trim-history.ts'

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
    assert.match(messages[0]?.content as string, /keep me/)
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
