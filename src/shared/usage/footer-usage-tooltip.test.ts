import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, SubagentSession, ToolCall } from '@shared/types'
import {
  buildFooterUsageTooltip,
  sumSubagentUsage,
  type FooterUsageTooltipRow,
} from './footer-usage-tooltip.ts'

function value(rows: FooterUsageTooltipRow[], label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value
}

describe('buildFooterUsageTooltip', () => {
  it('lists measured in/out with a cost row', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        measuredUsage: { inputTokens: 12_900_000, outputTokens: 211_000 },
      },
    )

    assert.equal(tooltip.header, 'Usage · 13.1M tokens')
    assert.equal(value(tooltip.rows, 'Input'), '12.9M')
    assert.equal(value(tooltip.rows, 'Output'), '211.0k')
    // Catalog prices move, so pin the shape of the cost line, not the amount.
    assert.match(value(tooltip.rows, 'Cost') ?? '', /^(~\$\d|<\$0\.01)/)
    assert.equal(tooltip.note, null)
  })

  it('adds cache read/write rows when the provider reports them', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 100_000, outputTokens: 4_000, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        measuredUsage: {
          inputTokens: 100_000,
          outputTokens: 4_000,
          cacheReadTokens: 90_000,
          cacheCreationTokens: 6_000,
        },
      },
    )

    assert.equal(value(tooltip.rows, 'Cache read'), '90.0k')
    assert.equal(value(tooltip.rows, 'Cache write'), '6.0k')
  })

  it('marks estimated usage and omits cost and cache detail', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 1200, outputTokens: 80, estimated: true },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        // A stale measured record must not leak cache/cost into an estimate.
        measuredUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5000 },
      },
    )

    assert.equal(tooltip.header, 'Usage · ~1.3k tokens')
    assert.equal(value(tooltip.rows, 'Input'), '~1.2k')
    assert.equal(value(tooltip.rows, 'Output'), '~80')
    assert.equal(value(tooltip.rows, 'Cache read'), undefined)
    assert.equal(value(tooltip.rows, 'Cost'), undefined)
    assert.equal(tooltip.note, 'Estimated — provider usage not reported yet')
  })

  it('notes when the model carries no pricing', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 1200, outputTokens: 80, estimated: false },
      {
        model: 'mystery-model',
        messages: [],
        measuredUsage: { inputTokens: 1200, outputTokens: 80 },
      },
    )

    assert.equal(value(tooltip.rows, 'Cost'), undefined)
    assert.equal(tooltip.note, 'No pricing for this model')
  })

  it('breaks cost down per model once a thread spans more than one', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 3200, outputTokens: 400, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        measuredUsage: {
          inputTokens: 3200,
          outputTokens: 400,
          byModel: {
            'claude-sonnet-4-6': { inputTokens: 2000, outputTokens: 300 },
            'lmstudio:qwen': { inputTokens: 1200, outputTokens: 100 },
          },
        },
      },
    )

    assert.equal(tooltip.modelRows.length, 2)
    assert.match(value(tooltip.modelRows, 'claude-sonnet-4-6') ?? '', /^2\.0k in \/ 300 out · /)
    assert.equal(value(tooltip.modelRows, 'lmstudio:qwen'), '1.2k in / 100 out · free')
  })

  it('keeps a single-model thread free of redundant per-model rows', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 2000, outputTokens: 300, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        measuredUsage: {
          inputTokens: 2000,
          outputTokens: 300,
          byModel: { 'claude-sonnet-4-6': { inputTokens: 2000, outputTokens: 300 } },
        },
      },
    )

    assert.deepEqual(tooltip.modelRows, [])
  })
})

describe('sumSubagentUsage', () => {
  function subagentToolCall(
    id: string,
    session: Partial<SubagentSession> & { usage?: SubagentSession['usage'] },
  ): ToolCall {
    return {
      id,
      name: 'explore',
      args: {},
      status: 'done',
      result: 'done',
      subagent: {
        id: `sub-${id}`,
        kind: 'explore',
        status: 'done',
        prompt: 'q',
        summary: null,
        messages: [],
        ...session,
      },
    }
  }

  function assistantWith(toolCalls: ToolCall[]): Message {
    return { id: 'a1', role: 'assistant', content: '', toolCalls, createdAt: 1 }
  }

  it('sums every subagent that reported usage', () => {
    const totals = sumSubagentUsage([
      assistantWith([
        subagentToolCall('t1', { usage: { inputTokens: 620_000, outputTokens: 21_000 } }),
        subagentToolCall('t2', { usage: { inputTokens: 540_000, outputTokens: 18_000 } }),
      ]),
    ])

    assert.deepEqual(totals, { runs: 2, inputTokens: 1_160_000, outputTokens: 39_000 })
  })

  it('recurses into nested subagents without double-counting', () => {
    // A nested subagent records onto its own session — run-subagent.ts does not
    // forward `usage` to its parent — so the tree sums additively.
    const nested = subagentToolCall('inner', {
      usage: { inputTokens: 100_000, outputTokens: 5_000 },
    })
    const outer = subagentToolCall('outer', {
      usage: { inputTokens: 400_000, outputTokens: 12_000 },
      messages: [{ id: 'sm1', role: 'assistant', content: '', toolCalls: [nested] }],
    })

    assert.deepEqual(sumSubagentUsage([assistantWith([outer])]), {
      runs: 2,
      inputTokens: 500_000,
      outputTokens: 17_000,
    })
  })

  it('ignores tool calls with no subagent and subagents still running', () => {
    const running = subagentToolCall('t1', { status: 'running' })
    const plain: ToolCall = { id: 't2', name: 'read_file', args: {}, status: 'done', result: 'ok' }

    assert.deepEqual(sumSubagentUsage([assistantWith([running, plain])]), {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})

describe('buildFooterUsageTooltip subagent row', () => {
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
            usage: { inputTokens: 2_100_000, outputTokens: 84_000 },
          },
        },
      ],
    },
  ]

  it('reports how much of the total was delegated work', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages,
        measuredUsage: { inputTokens: 12_900_000, outputTokens: 211_000 },
      },
    )

    assert.deepEqual(tooltip.subagentRow, {
      label: 'Subagents',
      value: '1 run · 2.1M in / 84.0k out',
    })
  })

  it('omits the row on an estimate, which has no reported subagent usage', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 1200, outputTokens: 80, estimated: true },
      {
        model: 'claude-sonnet-4-6',
        messages,
        measuredUsage: { inputTokens: 0, outputTokens: 0 },
      },
    )

    assert.equal(tooltip.subagentRow, null)
  })

  it('omits the row for a thread that never ran a subagent', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 2000, outputTokens: 300, estimated: false },
      {
        model: 'claude-sonnet-4-6',
        messages: [],
        measuredUsage: { inputTokens: 2000, outputTokens: 300 },
      },
    )

    assert.equal(tooltip.subagentRow, null)
  })
})
