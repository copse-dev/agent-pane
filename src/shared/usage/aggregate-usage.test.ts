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
import { formatPeriodHeadline } from './format-usage-summary.ts'
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
  it('flags a model row as estimated when any contributing event was estimated', () => {
    const summary = buildUsageSummary(
      [
        event({ model: 'acp:cursor#auto', inputTokens: 200, outputTokens: 40, estimated: true }),
        event({ model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 10 }),
      ],
      [],
      NOW,
    )
    const acp = summary.day.cloudModels.find((row) => row.model === 'acp:cursor#auto')
    const claude = summary.day.cloudModels.find((row) => row.model === 'claude-sonnet-4-6')
    assert.equal(acp?.estimatedTokens, true)
    assert.equal(claude?.estimatedTokens, undefined)
  })

  it('round-trips the estimated flag through parseUsageEvents', () => {
    const [parsed] = parseUsageEvents([
      {
        at: NOW,
        model: 'acp:cursor',
        source: 'agent',
        inputTokens: 5,
        outputTokens: 1,
        estimated: true,
      },
    ])
    assert.equal(parsed?.estimated, true)
  })

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

  it('keeps mixed tier calls separate and uses the actual response tier', () => {
    const usage = aggregateEventsByModel(
      [
        event({
          model: 'openrouter:vendor/tiered',
          inputTokens: 100,
          outputTokens: 10,
          requestedServiceTier: 'flex',
          responseServiceTier: 'priority',
        }),
        event({
          model: 'openrouter:vendor/tiered',
          inputTokens: 200,
          outputTokens: 20,
          requestedServiceTier: 'flex',
        }),
        event({ model: 'openrouter:vendor/tiered', inputTokens: 300, outputTokens: 30 }),
      ],
      DAY_MS,
      NOW,
    )
    assert.deepEqual(usage['openrouter:vendor/tiered'], {
      inputTokens: 600,
      outputTokens: 60,
      serviceTierUsage: {
        flex: { inputTokens: 200, outputTokens: 20 },
        priority: { inputTokens: 100, outputTokens: 10 },
      },
    })
  })

  it('preserves a persisted tier bucket and its fallback notice', () => {
    const summary = buildUsageSummary(
      [
        event({
          model: 'openrouter:vendor/no-tier-rate',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          requestedServiceTier: 'flex',
        }),
      ],
      [],
      NOW,
      {
        'openrouter:vendor/no-tier-rate': { inputPricePerMTok: 10, outputPricePerMTok: 20 },
      },
    )
    const row = summary.day.cloudModels[0]
    assert.equal(row?.estimatedCostUsd, 30)
    assert.equal(row.tierPricingFallback, true)
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
    assert.equal(summary.day.localModels[0]?.estimatedCostUsd, 0)
    assert.equal(summary.day.cloudModels[0]?.pricingKnown, true)
    assert.equal(summary.day.hasUnpricedCloudUsage, false)
    assert.equal(summary.trackingStartedAt, NOW - 1000)
    assert.equal(summary.ledgerEventCount, 2)
  })

  it('keeps free and unpriced cloud usage distinct', () => {
    const summary = buildUsageSummary(
      [
        event({ model: 'openrouter:vendor/free', inputTokens: 100, outputTokens: 10 }),
        event({ model: 'openrouter:vendor/unknown', inputTokens: 100, outputTokens: 10 }),
      ],
      [],
      NOW,
      {
        'openrouter:vendor/free': { inputPricePerMTok: 0, outputPricePerMTok: 0 },
      },
    )
    const free = summary.day.cloudModels.find((row) => row.model.endsWith('/free'))
    const unknown = summary.day.cloudModels.find((row) => row.model.endsWith('/unknown'))
    assert.equal(free?.pricingKnown, true)
    assert.equal(free.estimatedCostUsd, 0)
    assert.equal(unknown?.pricingKnown, false)
    assert.equal(summary.day.hasUnpricedCloudUsage, true)
    assert.equal(formatPeriodHeadline(summary.day), 'Cost unavailable · 2 cloud models')
  })

  it('round-trips a bounded hosting provider label and drops anything else', () => {
    const base = {
      at: NOW,
      model: 'openrouter:x-ai/grok-4.5',
      source: 'agent',
      inputTokens: 5,
      outputTokens: 1,
    }
    const parsed = parseUsageEvents([
      { ...base, hostingProvider: 'xAI' },
      { ...base, hostingProvider: 42 },
      { ...base, hostingProvider: '' },
      { ...base, hostingProvider: 'x'.repeat(81) },
    ])
    assert.equal(parsed.length, 4, 'a bad label never drops the usage itself')
    assert.deepEqual(
      parsed.map((e) => e.hostingProvider),
      ['xAI', undefined, undefined, undefined],
    )
  })

  it('parseUsageEvents drops malformed records', () => {
    const parsed = parseUsageEvents([
      { at: NOW, model: 'gpt-4o', inputTokens: 1, outputTokens: 2, source: 'agent' },
      { at: 'bad', model: 'gpt-4o', inputTokens: 1, outputTokens: 2, source: 'agent' },
      null,
    ])
    assert.equal(parsed.length, 1)
  })

  it('drops malformed persisted tier buckets without discarding usable standard usage', () => {
    const [parsed] = parseUsageEvents([
      {
        at: NOW,
        model: 'gpt-4o',
        source: 'agent',
        inputTokens: 100,
        outputTokens: 10,
        serviceTierUsage: { flex: null },
      },
    ])
    assert.equal(parsed?.inputTokens, 100)
    assert.equal(parsed.serviceTierUsage, undefined)
  })

  it('drops negative persisted tier buckets instead of creating a negative cost path', () => {
    const [parsed] = parseUsageEvents([
      {
        at: NOW,
        model: 'gpt-4o',
        source: 'agent',
        inputTokens: 100,
        outputTokens: 10,
        serviceTierUsage: { flex: { inputTokens: -1, outputTokens: 1 } },
      },
    ])
    assert.equal(parsed?.serviceTierUsage, undefined)
  })

  it('repairs legacy fresh-only ACP ledger events on read, idempotently', () => {
    const raw = [
      {
        at: NOW,
        model: 'acp:claude-acp#opus',
        source: 'agent',
        inputTokens: 3,
        outputTokens: 120,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 1_200,
      },
      {
        at: NOW,
        model: 'acp:claude-acp#opus',
        source: 'agent',
        inputTokens: 41_203,
        outputTokens: 1,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 1_200,
      },
    ]
    const parsed = parseUsageEvents(raw)
    assert.deepEqual(
      parsed.map((e) => e.inputTokens),
      [41_203, 41_203],
    )
    // A ledger write persists the parsed events; reading them again changes nothing.
    assert.deepEqual(parseUsageEvents(JSON.parse(JSON.stringify(parsed))), parsed)
  })

  it('lists classifier calls apart from cloud and local models, by connection and model', () => {
    const classifier = (
      provider: string,
      model: string,
      inputTokens: number,
      outputTokens: number,
      at = NOW - 1000,
    ): UsageEvent => event({ source: 'classifier', provider, model, inputTokens, outputTokens, at })
    const summary = buildUsageSummary(
      [
        event({ model: 'claude-sonnet-4-6', inputTokens: 1_000, outputTokens: 100 }),
        classifier('Kev (local)', 'kev-4b', 100, 2),
        classifier('Kev (local)', 'kev-4b', 50, 1),
        classifier('TypeSafe / Jev', 'jev-1', 400, 4),
        // The same model behind another connection is its own row.
        classifier('Kev (staging)', 'kev-4b', 10, 1),
        classifier('Kev (local)', 'kev-4b', 999, 9, NOW - 2 * DAY_MS),
      ],
      [],
      NOW,
    )
    assert.deepEqual(
      (summary.day.classifiers ?? []).map((row) => [
        row.provider,
        row.model,
        row.calls,
        row.inputTokens,
      ]),
      [
        ['TypeSafe / Jev', 'jev-1', 1, 400],
        ['Kev (local)', 'kev-4b', 2, 150],
        ['Kev (staging)', 'kev-4b', 1, 10],
      ],
    )
    assert.equal(
      (summary.month.classifiers ?? []).find((row) => row.provider === 'Kev (local)')?.calls,
      3,
    )
    // They are not chat-model usage: no cloud/local row, no cost, no unpriced warning.
    assert.deepEqual(
      summary.day.cloudModels.map((row) => row.model),
      ['claude-sonnet-4-6'],
    )
    assert.equal(summary.day.localModels.length, 0)
    assert.equal(summary.day.hasUnpricedCloudUsage, false)
    assert.equal(summary.day.totalInputTokens, 1_000)
    assert.deepEqual(summary.allTime.classifiers, [])
    assert.equal(summary.ledgerEventCount, 6)
  })

  it('names a classifier call with no recorded connection rather than dropping it', () => {
    const summary = buildUsageSummary(
      [event({ source: 'classifier', model: 'kev-4b', inputTokens: 5, outputTokens: 1 })],
      [],
      NOW,
    )
    assert.equal(summary.day.classifiers?.[0]?.provider, 'Classifier')
  })

  it('keeps a classifier event and its connection through a ledger round trip', () => {
    const [parsed] = parseUsageEvents([
      {
        at: NOW,
        model: 'kev-4b',
        source: 'classifier',
        inputTokens: 5,
        outputTokens: 1,
        provider: 'Kev (local)',
      },
    ])
    assert.ok(parsed)
    assert.equal(parsed.source, 'classifier')
    assert.equal(parsed.provider, 'Kev (local)')
    assert.deepEqual(aggregateEventsByModel([parsed], DAY_MS, NOW), {})
    // An unknown source is still dropped, and an oversized label is not kept.
    assert.deepEqual(
      parseUsageEvents([{ at: NOW, model: 'm', source: 'robot', inputTokens: 1, outputTokens: 1 }]),
      [],
    )
    const [long] = parseUsageEvents([
      {
        at: NOW,
        model: 'm',
        source: 'classifier',
        inputTokens: 1,
        outputTokens: 1,
        provider: 'x'.repeat(121),
      },
    ])
    assert.equal(long?.provider, undefined)
  })

  it('pruneUsageEvents removes entries older than 90 days', () => {
    const events: UsageEvent[] = [
      event({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1, at: NOW - 91 * DAY_MS }),
      event({ model: 'gpt-4o', inputTokens: 2, outputTokens: 2, at: NOW - DAY_MS }),
    ]
    const pruned = pruneUsageEvents(events, NOW)
    assert.equal(pruned.length, 1)
    assert.equal(pruned[0]?.inputTokens, 2)
  })
})
