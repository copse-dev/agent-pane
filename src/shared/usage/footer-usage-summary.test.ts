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

  it('folds subagent tokens back out of the measured total (#2464)', () => {
    // The main process folds a subagent's usage into the thread's raw totals
    // (subagent-usage.ts); resolveFooterUsage must subtract it back out so the
    // footer headline excludes recorded subagent sessions.
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'explore',
            args: {},
            status: 'done',
            result: 'done',
            subagent: {
              id: 'sub-1',
              kind: 'explore',
              status: 'done',
              prompt: 'q',
              summary: null,
              messages: [],
              model: 'lmstudio:qwen',
              usage: { inputTokens: 800_000, outputTokens: 15_000 },
            },
          },
        ],
      },
    ]

    const resolved = resolveFooterUsage({
      measured: { inputTokens: 12_900_000, outputTokens: 211_000 },
      running: false,
      messages,
    })

    assert.deepEqual(resolved, {
      inputTokens: 12_100_000,
      outputTokens: 196_000,
      estimated: false,
      subagentInputTokens: 800_000,
      subagentOutputTokens: 15_000,
    })
  })

  it('never goes negative when a subagent somehow out-totals the measured usage', () => {
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'explore',
            args: {},
            status: 'done',
            result: 'done',
            subagent: {
              id: 'sub-1',
              kind: 'explore',
              status: 'done',
              prompt: 'q',
              summary: null,
              messages: [],
              usage: { inputTokens: 500, outputTokens: 500 },
            },
          },
        ],
      },
    ]

    const resolved = resolveFooterUsage({
      measured: { inputTokens: 100, outputTokens: 100 },
      running: false,
      messages,
    })

    assert.deepEqual(resolved, {
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      subagentInputTokens: 500,
      subagentOutputTokens: 500,
    })
  })
})

describe('resolveFooterUsage subtracts only the folded subagent share', () => {
  const withExplore = (usage: { inputTokens: number; outputTokens: number }): Message[] => [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      createdAt: 1,
      toolCalls: [
        {
          id: 't1',
          name: 'explore',
          args: {},
          status: 'done',
          result: 'done',
          subagent: {
            id: 'sub-1',
            kind: 'explore',
            status: 'done',
            prompt: 'q',
            summary: null,
            messages: [],
            usage,
          },
        },
      ],
    },
  ]
  const explore = withExplore({ inputTokens: 800_000, outputTokens: 15_000 })

  it('keeps the whole total when a provider error skipped the fold', () => {
    // The subagent finished and recorded 800k, then the parent's next call
    // failed: runAgentLoop threw before main folded the subagent usage in.
    const resolved = resolveFooterUsage({
      measured: {
        inputTokens: 50_000,
        outputTokens: 2_000,
        subagentInputTokens: 0,
        subagentOutputTokens: 0,
      },
      running: false,
      messages: explore,
    })

    assert.deepEqual(resolved, {
      inputTokens: 50_000,
      outputTokens: 2_000,
      estimated: false,
      subagentInputTokens: 800_000,
      subagentOutputTokens: 15_000,
    })
  })

  it('does not drop mid-turn, between subagent_done and the fold', () => {
    const midTurn = resolveFooterUsage({
      measured: {
        inputTokens: 50_000,
        outputTokens: 2_000,
        subagentInputTokens: 0,
        subagentOutputTokens: 0,
      },
      running: true,
      messages: explore,
    })
    assert.equal(midTurn?.inputTokens, 50_000)
    assert.equal(midTurn.outputTokens, 2_000)

    const folded = resolveFooterUsage({
      measured: {
        inputTokens: 850_000,
        outputTokens: 17_000,
        subagentInputTokens: 800_000,
        subagentOutputTokens: 15_000,
      },
      running: false,
      messages: explore,
    })
    assert.equal(folded?.inputTokens, 50_000)
    assert.equal(folded.outputTokens, 2_000)
  })

  it('subtracts only the runs that were folded when an earlier turn failed', () => {
    const messages = [
      ...withExplore({ inputTokens: 800_000, outputTokens: 15_000 }),
      ...withExplore({ inputTokens: 100_000, outputTokens: 5_000 }),
    ]
    const resolved = resolveFooterUsage({
      measured: {
        inputTokens: 160_000,
        outputTokens: 9_000,
        subagentInputTokens: 100_000,
        subagentOutputTokens: 5_000,
      },
      running: false,
      messages,
    })
    assert.equal(resolved?.inputTokens, 60_000)
    assert.equal(resolved.outputTokens, 4_000)
    assert.equal(resolved.subagentInputTokens, 900_000)
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

  it('reports a published zero-rate cloud model as free', () => {
    assert.equal(
      formatFooterUsageDetail(
        { inputTokens: 1200, outputTokens: 80, estimated: false },
        {
          model: 'openrouter:vendor/free',
          measuredUsage: { inputTokens: 1200, outputTokens: 80 },
          pricing: {
            'openrouter:vendor/free': { inputPricePerMTok: 0, outputPricePerMTok: 0 },
          },
        },
      ),
      'Usage: 1.3k tokens · 1.2k in / 80 out · free',
    )
  })

  it('labels cost as whole-thread when the token total excludes subagents', () => {
    const detail = formatFooterUsageDetail(
      {
        inputTokens: 1200,
        outputTokens: 80,
        estimated: false,
        subagentInputTokens: 500,
        subagentOutputTokens: 20,
      },
      {
        model: 'claude-sonnet-4-6',
        measuredUsage: { inputTokens: 1700, outputTokens: 100 },
      },
    )

    assert.match(detail, /· whole-thread cost (~\$|<\$)/)
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
