import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@shared/types'
import {
  contextPressureChunk,
  prepareAgentHistory,
  promptExceedsContextWindow,
  oversizedTurnMessage,
} from './history-trimming.ts'

/** A user message whose text is `chars` characters long (~chars/4 tokens). */
function userMessage(chars: number): LLMMessage {
  return { role: 'user', content: 'x'.repeat(chars) }
}

describe('prepareAgentHistory', () => {
  it('reports the estimated prompt tokens (system + trimmed conversation)', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'y'.repeat(400) }, // ~100 tokens
      userMessage(800), // ~200 tokens
    ]
    const prepared = prepareAgentHistory(messages, 128_000, 0)
    assert.equal(prepared.estimatedPromptTokens, 300)
  })
})

describe('contextPressureChunk', () => {
  it('counts the system prompt and tool schemas, like the measured readings that follow', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: 'y'.repeat(4000) }, userMessage(80)]
    const prepared = prepareAgentHistory(messages, 128_000, 5000)
    const chunk = contextPressureChunk(prepared, 128_000, 5000)
    assert.equal(chunk.type, 'context_pressure')
    if (chunk.type !== 'context_pressure') return
    // ~1000 system + ~20 user + 5000 tool schemas, not just the ~20 conversation tokens.
    assert.ok(chunk.conversationTokens > 6000, String(chunk.conversationTokens))
    assert.ok(chunk.conversationTokens > prepared.initialConversationTokens)
    assert.equal(chunk.fillRatio, chunk.conversationTokens / prepared.conversationBudget)
  })
})

describe('promptExceedsContextWindow', () => {
  it('is false when a single turn fits the window', () => {
    const prepared = prepareAgentHistory([userMessage(800)], 8192, 0)
    assert.equal(promptExceedsContextWindow(prepared, 8192), false)
  })

  it('is true when one user turn alone overflows even after trimming', () => {
    // ~40k chars ≈ 10k tokens, well past an 8192-token local window. Trimming
    // cannot help: it never drops the user's own message.
    const prepared = prepareAgentHistory([userMessage(40_000)], 8192, 0)
    assert.equal(prepared.wasTrimmed, false)
    assert.equal(promptExceedsContextWindow(prepared, 8192), true)
  })

  it('triggers exactly at the window boundary (no completion room left)', () => {
    const prepared = prepareAgentHistory([userMessage(8192 * 4)], 8192, 0)
    assert.equal(promptExceedsContextWindow(prepared, 8192), true)
  })
})

describe('oversizedTurnMessage', () => {
  it('names both the needed size and the model window', () => {
    const msg = oversizedTurnMessage(8192, 10_000)
    assert.match(msg, /10,000/)
    assert.match(msg, /8,192/)
    assert.match(msg, /read_file|larger context/)
  })
})
