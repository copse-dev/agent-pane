import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFooterUsageTooltip, type FooterUsageTooltipRow } from './footer-usage-tooltip.ts'

function value(rows: FooterUsageTooltipRow[], label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value
}

describe('buildFooterUsageTooltip', () => {
  it('lists measured in/out with a cost row', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false },
      {
        model: 'claude-sonnet-4-6',
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
      { model: 'mystery-model', measuredUsage: { inputTokens: 1200, outputTokens: 80 } },
    )

    assert.equal(value(tooltip.rows, 'Cost'), undefined)
    assert.equal(tooltip.note, 'No pricing for this model')
  })

  it('breaks cost down per model once a thread spans more than one', () => {
    const tooltip = buildFooterUsageTooltip(
      { inputTokens: 3200, outputTokens: 400, estimated: false },
      {
        model: 'claude-sonnet-4-6',
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
