import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, SubagentMessage } from '@shared/types'
import {
  estimateAssistantOutputTokens,
  formatFooterUsageSummary,
  resolveFooterUsage,
} from './footer-usage-summary.ts'

function assistant(content: string): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    toolCalls: [],
    createdAt: 1,
  }
}

function subagentAssistant(content: string): SubagentMessage {
  return {
    id: 'sa1',
    role: 'assistant',
    content,
    toolCalls: [],
  }
}

describe('estimateAssistantOutputTokens', () => {
  it('counts assistant text and nested subagent replies', () => {
    const messages: Message[] = [
      assistant('Hello'),
      {
        ...assistant(''),
        toolCalls: [
          {
            id: 'tc1',
            name: 'explore',
            args: {},
            status: 'done',
            result: 'summary',
            subagent: {
              id: 'sub1',
              kind: 'explore',
              status: 'done',
              prompt: 'q',
              summary: 'summary',
              messages: [subagentAssistant('Nested reply')],
            },
          },
        ],
      },
    ]
    assert.equal(
      estimateAssistantOutputTokens(messages),
      Math.round('HelloNested reply'.length / 4),
    )
  })
})

describe('resolveFooterUsage', () => {
  it('returns measured usage when provider reported tokens', () => {
    const resolved = resolveFooterUsage({
      measured: { inputTokens: 100, outputTokens: 20 },
      running: false,
      messages: [],
      model: 'claude-sonnet-4-6',
    })
    assert.deepEqual(resolved, { inputTokens: 100, outputTokens: 20, estimated: false })
  })

  it('narrows to the footer model when a per-model breakdown is present', () => {
    const resolved = resolveFooterUsage({
      measured: {
        inputTokens: 9_625_891,
        outputTokens: 121_158,
        byModel: {
          'openrouter:paid-model': { inputTokens: 100, outputTokens: 20 },
          'lmstudio:qwen': { inputTokens: 9_625_791, outputTokens: 121_138 },
        },
      },
      running: false,
      messages: [],
      model: 'openrouter:paid-model',
    })
    assert.deepEqual(resolved, { inputTokens: 100, outputTokens: 20, estimated: false })
  })

  it('reports zero when the breakdown exists but the footer model has not spent yet', () => {
    const resolved = resolveFooterUsage({
      measured: {
        inputTokens: 5000,
        outputTokens: 500,
        byModel: { 'lmstudio:qwen': { inputTokens: 5000, outputTokens: 500 } },
      },
      running: false,
      messages: [],
      model: 'openrouter:paid-model',
    })
    assert.deepEqual(resolved, { inputTokens: 0, outputTokens: 0, estimated: false })
  })

  it('falls back to the thread-wide total when there is no breakdown (legacy threads)', () => {
    const resolved = resolveFooterUsage({
      measured: { inputTokens: 100, outputTokens: 20 },
      running: false,
      messages: [],
      model: 'openrouter:paid-model',
    })
    assert.deepEqual(resolved, { inputTokens: 100, outputTokens: 20, estimated: false })
  })

  it('estimates from context snapshot and assistant text when measured usage is zero', () => {
    const resolved = resolveFooterUsage({
      measured: { inputTokens: 0, outputTokens: 0 },
      running: true,
      messages: [assistant('abcd'.repeat(10))],
      contextSnapshot: {
        contextWindow: 16_384,
        conversationBudget: 12_000,
        conversationTokens: 500,
        fillRatio: 500 / 12_000,
        updatedAt: Date.now(),
      },
      model: 'claude-sonnet-4-6',
    })
    assert.deepEqual(resolved, {
      inputTokens: 500,
      outputTokens: 10,
      estimated: true,
    })
  })

  it('uses pre-send breakdown when idle with no snapshot', () => {
    const resolved = resolveFooterUsage({
      measured: { inputTokens: 0, outputTokens: 0 },
      running: false,
      messages: [],
      breakdown: { segments: [], totalTokens: 800, contextWindow: 16_384 },
      model: 'claude-sonnet-4-6',
    })
    assert.deepEqual(resolved, { inputTokens: 800, outputTokens: 0, estimated: true })
  })

  it('hides when idle with no measured or estimated signal', () => {
    assert.equal(
      resolveFooterUsage({
        measured: { inputTokens: 0, outputTokens: 0 },
        running: false,
        messages: [],
        model: 'claude-sonnet-4-6',
      }),
      null,
    )
  })
})

describe('formatFooterUsageSummary', () => {
  it('prefixes estimated totals with ~ and uses est. for cost', () => {
    assert.equal(
      formatFooterUsageSummary(
        { inputTokens: 1200, outputTokens: 80, estimated: true },
        {
          costVisible: true,
          model: 'lmstudio:qwen',
          measuredUsage: { inputTokens: 0, outputTokens: 0 },
        },
      ),
      '~1200 in / ~80 out · est.',
    )
  })

  it('keeps measured formatting without ~ prefix', () => {
    assert.equal(
      formatFooterUsageSummary(
        { inputTokens: 1200, outputTokens: 80, estimated: false },
        {
          costVisible: false,
          model: 'claude-sonnet-4-6',
          measuredUsage: { inputTokens: 1200, outputTokens: 80 },
        },
      ),
      '1.3k tokens',
    )
  })

  it('rolls over to M for millions of tokens', () => {
    assert.equal(
      formatFooterUsageSummary(
        { inputTokens: 4_200_000, outputTokens: 53_600, estimated: false },
        {
          costVisible: false,
          model: 'claude-sonnet-4-6',
          measuredUsage: { inputTokens: 4_200_000, outputTokens: 53_600 },
        },
      ),
      '4.3M tokens',
    )
  })
})
