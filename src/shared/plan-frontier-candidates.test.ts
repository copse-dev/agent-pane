import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openRouterFrontierCandidates } from '@copse/llm/frontier-candidates.ts'
import { getModelInfo } from '@copse/llm/model-catalog.ts'
import { getIntellectScore } from '@copse/llm/model-intellect.ts'
import {
  blendedPricePerMTok,
  frontierForKnownModels,
  type FrontierCandidate,
} from '@copse/llm/pareto-frontier.ts'
import { pickDynamicModel } from '@copse/llm/dynamic-model-pick.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import type { AcpAgentConfig } from './types/acp.ts'
import { applyPlanCoverage } from './plan-inclusion.ts'
import { planAcpFrontierCandidates } from './plan-frontier-candidates.ts'

const CODEX: AcpAgentConfig = {
  id: 'codex-acp',
  title: 'Codex',
  command: 'codex-acp',
  enabled: true,
  availableModels: [{ value: 'gpt-6-sol', label: 'GPT-6 Sol' }],
}

function pricedSol(): FrontierCandidate[] {
  return openRouterFrontierCandidates([
    { id: 'openai/gpt-6-sol', name: 'GPT-6 Sol', inputPricePerMTok: 4, outputPricePerMTok: 20 },
  ])
}

function usage(usedPercent: number): PlanUsageSnapshot {
  return {
    checkedAt: '2026-10-01T00:00:00Z',
    providers: [
      {
        provider: 'codex',
        status: 'ok',
        usage: {
          provider: 'codex',
          plan: 'plus',
          checkedAt: '2026-10-01T00:00:00Z',
          windows: [{ id: 'primary', label: '5-hour', usedPercent, resetsAt: null }],
        },
      },
    ],
  }
}

describe('ACP candidates while bundled pricing catches up', () => {
  it('uses live pricing for the exact scored Sol model and keeps the ACP route', () => {
    // Keep this fixture outside the bundled catalog so the test exercises a
    // launch before the next pricing sync, rather than the catalog happy path.
    assert.equal(getModelInfo('gpt-6-sol'), null)
    const priced = pricedSol()
    const score = getIntellectScore('gpt-6-sol')
    assert.ok(score)
    const candidates = planAcpFrontierCandidates([CODEX], priced)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.id, 'acp:codex-acp#gpt-6-sol')
    assert.equal(candidates[0].intellect, score.value)
    assert.equal(candidates[0].costPerMTok, priced[0]?.costPerMTok)
    assert.deepEqual(candidates[0].planAccess, { provider: 'codex', modelId: 'gpt-6-sol' })
    assert.equal(candidates[0].plan, undefined)

    const points = frontierForKnownModels(
      [...priced, ...candidates],
      (candidate) => applyPlanCoverage(candidate, usage(20)),
      (candidate) => candidate.id.startsWith('acp:') || candidate.id.startsWith('openrouter:'),
    )
    assert.equal(points.length, 1, 'the paid duplicate must fold into the included route')
    const picked = pickDynamicModel({ kind: 'balanced' }, points)
    assert.equal(picked?.id, 'acp:codex-acp#gpt-6-sol')
    assert.equal(picked.plan, '5-hour')
    assert.equal(picked.costPerMTok, 0)
  })

  it('matches GPT-6.1 Sol bundled pricing to its distinct benchmark id and prefers ACP', () => {
    const model = 'gpt-6.1-sol'
    const info = getModelInfo(model)
    assert.ok(info)
    const candidates = planAcpFrontierCandidates([
      { ...CODEX, availableModels: [{ value: model, label: 'GPT-6.1 Sol' }] },
    ])
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.id, 'acp:codex-acp#gpt-6.1-sol')
    assert.equal(candidates[0].costPerMTok, blendedPricePerMTok(info))
    assert.equal(candidates[0].planAccess?.modelId, 'gpt-6-1-sol')
    const score = getIntellectScore(model)
    assert.ok(score?.estimated, 'noncanonical benchmark scores must be marked estimated')
    assert.equal(candidates[0].intellectEstimated, true)
    const paid = openRouterFrontierCandidates([
      { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', ...info },
    ])
    assert.equal(paid.length, 1)
    const points = frontierForKnownModels(
      [...paid, ...candidates],
      (candidate) => applyPlanCoverage(candidate, usage(20)),
      (candidate) => candidate.id.startsWith('acp:') || candidate.id.startsWith('openrouter:'),
    )
    assert.equal(points.length, 1)
    const picked = pickDynamicModel({ kind: 'balanced' }, points)
    assert.equal(picked?.id, 'acp:codex-acp#gpt-6.1-sol')
    assert.equal(picked.plan, '5-hour')
    assert.equal(picked.costPerMTok, 0)
    assert.equal(
      picked.intellectEstimated,
      true,
      'plan identity folding must preserve the estimate',
    )
  })

  it('does not infer free usage from the presence of a live price', () => {
    const candidate = planAcpFrontierCandidates([CODEX], pricedSol())[0]
    assert.ok(candidate)
    for (const snapshot of [null, usage(100)]) {
      const adjusted = applyPlanCoverage(candidate, snapshot)
      assert.equal(adjusted.plan, undefined)
      assert.equal(adjusted.planDetail, undefined)
      assert.equal(adjusted.costPerMTok, candidate.costPerMTok)
    }
  })

  it('keeps bundled pricing authoritative when it exists', () => {
    const info = getModelInfo('gpt-5.6-sol')
    assert.ok(info)
    const candidates = planAcpFrontierCandidates(
      [{ ...CODEX, availableModels: [{ value: 'gpt-5.6-sol', label: 'Sol' }] }],
      [{ id: 'openrouter:openai/gpt-5.6-sol', intellect: 60, costPerMTok: 0.01 }],
    )
    assert.equal(candidates[0]?.costPerMTok, blendedPricePerMTok(info))
  })

  it('does not borrow a sibling model price or invent unmeasured models', () => {
    assert.deepEqual(
      planAcpFrontierCandidates(
        [CODEX],
        [{ id: 'openrouter:openai/gpt-6-astra', intellect: 60, costPerMTok: 20 }],
      ),
      [],
    )
    assert.deepEqual(
      planAcpFrontierCandidates(
        [{ ...CODEX, availableModels: [{ value: 'unmeasured-new-model', label: 'New model' }] }],
        pricedSol(),
      ),
      [],
    )
    assert.deepEqual(planAcpFrontierCandidates([{ ...CODEX, enabled: false }], pricedSol()), [])
  })

  it('rejects invalid or already-discounted price evidence', () => {
    for (const route of [
      { id: 'openrouter:openai/gpt-6-sol', intellect: 60, costPerMTok: NaN },
      { id: 'openrouter:openai/gpt-6-sol', intellect: 60, costPerMTok: Infinity },
      { id: 'openrouter:openai/gpt-6-sol', intellect: 60, costPerMTok: -1 },
      { id: 'lmstudio:gpt-6-sol', intellect: 60, costPerMTok: 0, local: true },
      { id: 'acp:codex-acp#gpt-6-sol', intellect: 60, costPerMTok: 0, plan: 'Weekly' },
    ]) {
      assert.deepEqual(planAcpFrontierCandidates([CODEX], [route]), [])
    }
  })
})
