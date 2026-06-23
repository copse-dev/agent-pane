import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateEventsByModel,
  aggregateThreadUsage,
  buildUsageSummary,
  DAY_MS,
  mergeUsageByModel,
  parseUsageEvents,
  pruneUsageEvents,
} from './aggregate-usage.ts'
import type { Thread } from '@shared/types'
import type { UsageEvent } from './usage-event.ts'

const NOW = Date.parse('2026-06-23T12:00:00.000Z')

function event(
  partial: Partial<UsageEvent> & Pick<UsageEvent, 'model' | 'inputTokens' | 'outputTokens'>,
): UsageEvent {
  return {
    at: NOW - 60_000,
    source: 'agent',
    ...partial,
  }
}

describe('aggregate usage', () => {
  it('mergeUsageByModel accumulates cache fields', () => {
    const byModel = mergeUsageByModel({}, 'claude-sonnet-4-6', {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
    })
    const next = mergeUsageByModel(byModel, 'claude-sonnet-4-6', {
      inputTokens: 50,
      outputTokens: 5,
      cacheCreationTokens: 20,
    })
    assert.deepEqual(next['claude-sonnet-4-6'], {
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
    })
  })

  it('aggregateEventsByModel filters by rolling window', () => {
    const events: UsageEvent[] = [
      event({
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 10,
        at: NOW - DAY_MS + 1,
      }),
      event({ model: 'gpt-4o', inputTokens: 200, outputTokens: 20, at: NOW - DAY_MS - 1 }),
    ]
    const day = aggregateEventsByModel(events, DAY_MS, NOW)
    assert.equal(day['claude-sonnet-4-6']?.inputTokens, 100)
    assert.equal(day['gpt-4o'], undefined)
  })

  it('aggregateThreadUsage merges per-model totals across threads', () => {
    const threads: Thread[] = [
      {
        id: 't1',
        title: 'A',
        status: 'idle',
        messages: [],
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          byModel: { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 10 } },
        },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 't2',
        title: 'B',
        status: 'idle',
        messages: [],
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          byModel: {
            'claude-sonnet-4-6': { inputTokens: 30, outputTokens: 3 },
            'lmstudio:qwen': { inputTokens: 20, outputTokens: 2 },
          },
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const byModel = aggregateThreadUsage(threads)
    assert.equal(byModel['claude-sonnet-4-6']?.inputTokens, 130)
    assert.equal(byModel['lmstudio:qwen']?.inputTokens, 20)
  })

  it('buildUsageSummary splits cloud and local rows with costs', () => {
    const events: UsageEvent[] = [
      event({
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        at: NOW - 1000,
      }),
      event({ model: 'lmstudio:qwen', inputTokens: 500_000, outputTokens: 0, at: NOW - 1000 }),
    ]
    const summary = buildUsageSummary(events, [], NOW)
    assert.equal(summary.day.cloudModels.length, 1)
    assert.equal(summary.day.localModels.length, 1)
    assert.ok(summary.day.totalCostUsd > 0)
    assert.equal(summary.day.localModels[0]!.estimatedCostUsd, 0)
    assert.equal(summary.trackingStartedAt, NOW - 1000)
  })

  it('parseUsageEvents drops malformed records', () => {
    const parsed = parseUsageEvents([
      { at: NOW, model: 'gpt-4o', inputTokens: 1, outputTokens: 2, source: 'agent' },
      { at: 'bad', model: 'gpt-4o', inputTokens: 1, outputTokens: 2, source: 'agent' },
      null,
    ])
    assert.equal(parsed.length, 1)
  })

  it('pruneUsageEvents removes entries older than 90 days', () => {
    const events: UsageEvent[] = [
      event({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1, at: NOW - 91 * DAY_MS }),
      event({ model: 'gpt-4o', inputTokens: 2, outputTokens: 2, at: NOW - DAY_MS }),
    ]
    const pruned = pruneUsageEvents(events, NOW)
    assert.equal(pruned.length, 1)
    assert.equal(pruned[0]!.inputTokens, 2)
  })
})
