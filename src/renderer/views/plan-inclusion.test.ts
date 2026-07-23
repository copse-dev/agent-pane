import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanProviderId, PlanUsageSnapshot, PlanWindow } from '@copse/plan-usage'
import type { FrontierCandidate } from '@copse/llm/pareto-frontier.ts'
import {
  applyPlanCoverage,
  claudeGoverningWindowIds,
  codexGoverningWindowIds,
  planInclusionHint,
  planProviderForModel,
  resolvePlanInclusion,
} from './plan-inclusion.ts'

function snapshot(
  provider: PlanProviderId,
  windows: Array<Partial<PlanWindow> & { id: string; usedPercent: number }>,
): PlanUsageSnapshot {
  return {
    checkedAt: '2026-07-19T00:00:00Z',
    providers: [
      {
        status: 'ok',
        provider,
        usage: {
          provider,
          plan: 'Max',
          checkedAt: '2026-07-19T00:00:00Z',
          windows: windows.map((w) => ({
            id: w.id,
            label: w.label ?? w.id,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt ?? null,
          })),
        },
      },
    ],
  }
}

describe('claudeGoverningWindowIds', () => {
  it('puts the per-model weekly cap first, then the pools', () => {
    assert.deepEqual(claudeGoverningWindowIds('claude-fable-5'), [
      'seven_day_fable',
      'seven_day',
      'five_hour',
    ])
    assert.deepEqual(claudeGoverningWindowIds('claude-opus-4-8'), [
      'seven_day_opus',
      'seven_day',
      'five_hour',
    ])
  })

  it('omits the per-model cap for a model with no known family', () => {
    assert.deepEqual(claudeGoverningWindowIds('some-unknown'), ['seven_day', 'five_hour'])
  })
})

describe('codexGoverningWindowIds', () => {
  it('includes primary/secondary plus a metered window when the label names the model', () => {
    const windows: PlanWindow[] = [
      { id: 'primary', label: '5-hour', usedPercent: 10, resetsAt: null },
      { id: 'secondary', label: 'Weekly', usedPercent: 5, resetsAt: null },
      {
        id: 'codex-bengalfox_primary',
        label: 'GPT-5.3-Codex-Spark 5-hour',
        usedPercent: 40,
        resetsAt: null,
      },
    ]
    assert.deepEqual(codexGoverningWindowIds('gpt-5.3-codex-spark', windows), [
      'primary',
      'secondary',
      'codex-bengalfox_primary',
    ])
  })

  it('falls back to the shared pools when there is no per-model window', () => {
    assert.deepEqual(codexGoverningWindowIds('gpt-5.6-sol'), ['primary', 'secondary'])
  })
})

describe('resolvePlanInclusion', () => {
  it('returns included with the tightest governing window as the binding one', () => {
    const snap = snapshot('claude', [
      { id: 'five_hour', label: '5-hour', usedPercent: 20 },
      { id: 'seven_day', label: 'Weekly', usedPercent: 40 },
      { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 65 },
    ])
    const inc = resolvePlanInclusion('claude', 'claude-fable-5', snap)
    assert.ok(inc)
    assert.equal(inc.exhausted, false)
    // Fable's own weekly cap (65%) is tighter than the pools, so it binds.
    assert.equal(inc.windowLabel, 'Weekly Fable')
    assert.equal(inc.usedPercent, 65)
  })

  it('flags the model as limit-reached when its OWN cap is spent even though the pool has room', () => {
    const snap = snapshot('claude', [
      { id: 'seven_day', label: 'Weekly', usedPercent: 30 },
      {
        id: 'seven_day_fable',
        label: 'Weekly Fable',
        usedPercent: 100,
        resetsAt: '2026-07-21T00:00:00Z',
      },
    ])
    const inc = resolvePlanInclusion('claude', 'claude-fable-5', snap)
    assert.ok(inc)
    assert.equal(inc.exhausted, true)
    assert.equal(inc.windowLabel, 'Weekly Fable')
    assert.match(planInclusionHint(inc), /Weekly Fable plan limit reached \(resets \w+\)/)
  })

  it('falls back to the weekly/5-hour pools when there is no per-model window', () => {
    const snap = snapshot('claude', [
      { id: 'five_hour', label: '5-hour', usedPercent: 90 },
      { id: 'seven_day', label: 'Weekly', usedPercent: 50 },
    ])
    const inc = resolvePlanInclusion('claude', 'claude-opus-4-8', snap)
    assert.ok(inc)
    // 5-hour (90%) is tighter than the weekly pool, so it binds.
    assert.equal(inc.windowLabel, '5-hour')
    assert.equal(inc.usedPercent, 90)
    assert.match(planInclusionHint(inc), /plan included · 5-hour 90% used/)
  })

  it('binds Codex coverage to the tightest primary/secondary pool', () => {
    const snap = snapshot('codex', [
      { id: 'primary', label: '5-hour', usedPercent: 22 },
      { id: 'secondary', label: 'Weekly', usedPercent: 8 },
    ])
    const inc = resolvePlanInclusion('codex', 'gpt-5.6-sol', snap)
    assert.ok(inc)
    assert.equal(inc.windowLabel, '5-hour')
    assert.equal(inc.usedPercent, 22)
    assert.equal(inc.exhausted, false)
  })

  it('binds Cursor coverage to its included pool windows', () => {
    const snap = snapshot('cursor', [
      { id: 'total', label: 'Total included', usedPercent: 55 },
      { id: 'spend_limit', label: 'On-demand', usedPercent: 0 },
    ])
    const inc = resolvePlanInclusion('cursor', 'composer-2', snap)
    assert.ok(inc)
    assert.equal(inc.windowLabel, 'Total included')
    assert.equal(inc.exhausted, false)
  })

  it('returns null when the provider is not on a readable plan', () => {
    const snap: PlanUsageSnapshot = {
      checkedAt: '2026-07-19T00:00:00Z',
      providers: [{ status: 'unavailable', provider: 'claude', reason: 'no credential' }],
    }
    assert.equal(resolvePlanInclusion('claude', 'claude-opus-4-8', snap), null)
  })

  it('returns null when no window governs the model (never implies free)', () => {
    const snap = snapshot('claude', [{ id: 'unrelated', label: 'Other', usedPercent: 10 }])
    assert.equal(resolvePlanInclusion('claude', 'claude-opus-4-8', snap), null)
  })
})

describe('planProviderForModel', () => {
  it('maps Claude models to the Claude plan, GPT to Codex, and Grok to Cursor', () => {
    assert.equal(planProviderForModel('claude-fable-5'), 'claude')
    assert.equal(planProviderForModel('anthropic/claude-opus-4-8'), 'claude')
    assert.equal(planProviderForModel('gpt-5.6-sol'), 'codex')
    assert.equal(planProviderForModel('openai/gpt-5.6-sol'), 'codex')
    assert.equal(planProviderForModel('grok-4.5'), 'cursor')
  })
  it('leaves unmapped models with no plan provider', () => {
    assert.equal(planProviderForModel('lmstudio:qwen/qwen2.5-coder-32b'), null)
  })
})

describe('applyPlanCoverage', () => {
  const candidate: FrontierCandidate = { id: 'claude-fable-5', intellect: 60, costPerMTok: 12 }

  it('drops a covered model to $0 with a plan badge, keeping the off-plan price', () => {
    const snap = snapshot('claude', [
      {
        id: 'seven_day_fable',
        label: 'Weekly Fable',
        usedPercent: 30,
        resetsAt: '2026-07-21T00:00:00Z',
      },
    ])
    const out = applyPlanCoverage(candidate, snap)
    assert.equal(out.costPerMTok, 0)
    assert.equal(out.plan, 'Weekly Fable')
    assert.deepEqual(out.planDetail, {
      usedPercent: 30,
      resetsAt: '2026-07-21T00:00:00Z',
      apiPricePerMTok: 12,
    })
    assert.equal(out.planLimitReached, undefined)
  })

  it('keeps the real price and notes limit-reached when the window is spent', () => {
    const snap = snapshot('claude', [
      {
        id: 'seven_day_fable',
        label: 'Weekly Fable',
        usedPercent: 100,
        resetsAt: '2026-07-21T00:00:00Z',
      },
    ])
    const out = applyPlanCoverage(candidate, snap)
    assert.equal(out.costPerMTok, 12)
    assert.equal(out.plan, undefined)
    assert.deepEqual(out.planLimitReached, {
      label: 'Weekly Fable',
      resetsAt: '2026-07-21T00:00:00Z',
    })
  })

  it('passes through unchanged with no snapshot or an unmapped model', () => {
    assert.equal(applyPlanCoverage(candidate, null), candidate)
    const snap = snapshot('claude', [{ id: 'seven_day', label: 'Weekly', usedPercent: 10 }])
    const local: FrontierCandidate = {
      id: 'lmstudio:qwen/qwen2.5-coder-32b',
      intellect: 40,
      costPerMTok: 0,
    }
    assert.equal(applyPlanCoverage(local, snap), local)
  })

  it('drops a covered GPT model to $0 when Codex plan windows have headroom', () => {
    const gpt: FrontierCandidate = { id: 'gpt-5.6-sol', intellect: 59, costPerMTok: 18 }
    const snap = snapshot('codex', [
      { id: 'primary', label: '5-hour', usedPercent: 11, resetsAt: '2026-07-21T00:00:00Z' },
      { id: 'secondary', label: 'Weekly', usedPercent: 7, resetsAt: '2026-07-28T00:00:00Z' },
    ])
    const out = applyPlanCoverage(gpt, snap)
    assert.equal(out.costPerMTok, 0)
    assert.equal(out.plan, '5-hour')
    assert.deepEqual(out.planDetail, {
      usedPercent: 11,
      resetsAt: '2026-07-21T00:00:00Z',
      apiPricePerMTok: 18,
    })
  })
})
