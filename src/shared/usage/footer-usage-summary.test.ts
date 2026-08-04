import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, SubagentMessage } from '@shared/types'
import {
  estimateAssistantOutputTokens,
  formatFooterUsageDetail,
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
    })
    assert.deepEqual(resolved, { inputTokens: 800, outputTokens: 0, estimated: true })
  })

  it('hides when idle with no measured or estimated signal', () => {
    assert.equal(
      resolveFooterUsage({
        measured: { inputTokens: 0, outputTokens: 0 },
        running: false,
        messages: [],
      }),
      null,
    )
  })
})

describe('formatFooterUsageSummary', () => {
  it('prefixes estimated totals with ~', () => {
    assert.equal(
      formatFooterUsageSummary({ inputTokens: 1200, outputTokens: 80, estimated: true }),
      '~1.3k tokens',
    )
  })

  it('keeps measured formatting without ~ prefix', () => {
    assert.equal(
      formatFooterUsageSummary({ inputTokens: 1200, outputTokens: 80, estimated: false }),
      '1.3k tokens',
    )
  })

  it('rolls over to M for millions of tokens', () => {
    assert.equal(
      formatFooterUsageSummary({ inputTokens: 4_200_000, outputTokens: 53_600, estimated: false }),
      '4.3M tokens',
    )
  })
})

describe('formatFooterUsageDetail', () => {
  it('marks estimated counts and cost as approximate', () => {
    assert.equal(
      formatFooterUsageDetail(
        { inputTokens: 1200, outputTokens: 80, estimated: true },
        { model: 'lmstudio:qwen', measuredUsage: { inputTokens: 0, outputTokens: 0 } },
      ),
      'Usage: ~1.3k tokens · ~1.2k in / ~80 out · est.',
    )
  })

  it('reports local models as free rather than a dollar figure', () => {
    assert.equal(
      formatFooterUsageDetail(
        { inputTokens: 1200, outputTokens: 80, estimated: false },
        { model: 'lmstudio:qwen', measuredUsage: { inputTokens: 1200, outputTokens: 80 } },
      ),
      'Usage: 1.3k tokens · 1.2k in / 80 out · free (local)',
    )
  })

  it('drops the cost segment when the model has no pricing', () => {
    assert.equal(
      formatFooterUsageDetail(
        { inputTokens: 1200, outputTokens: 80, estimated: false },
        { model: 'mystery-model', measuredUsage: { inputTokens: 1200, outputTokens: 80 } },
      ),
      'Usage: 1.3k tokens · 1.2k in / 80 out',
    )
  })
})

describe('formatFooterUsageDetail leads with the counter total', () => {
  // The compact footer hides the token counter and shows only this line, in the
  // context wheel's title — so it must still answer "how many tokens?".
  // tests/demo/footer-compact.demo.ts pins that against the demo scenario.
  it('starts with the same label the counter would show', () => {
    const display = { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false }
    const detail = formatFooterUsageDetail(display, {
      model: 'claude-sonnet-4-6',
      measuredUsage: { inputTokens: 12_900_000, outputTokens: 211_000 },
    })

    assert.ok(
      detail.includes(formatFooterUsageSummary(display)),
      `expected "${detail}" to contain "${formatFooterUsageSummary(display)}"`,
    )
    assert.match(detail, /^Usage: 13\.1M tokens · 12\.9M in \/ 211\.0k out · /)
  })
})
