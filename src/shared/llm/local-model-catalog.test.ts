import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ROLE_IDS } from './agent-roles.ts'
import {
  BENCHMARKS,
  LOCAL_MODEL_CATALOG,
  getLocalModelCapability,
  recommendLocalModelsForRole,
  type Benchmark,
} from './local-model-catalog.ts'

describe('local model catalog', () => {
  it('has unique ids', () => {
    const ids = LOCAL_MODEL_CATALOG.map((m) => m.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('exposes positive sizing and sane MoE active params for every entry', () => {
    for (const m of LOCAL_MODEL_CATALOG) {
      assert.ok(m.label.trim().length > 0, `${m.id}: label`)
      assert.ok(m.paramsB > 0, `${m.id}: paramsB`)
      assert.ok(m.downloadGb > 0, `${m.id}: downloadGb`)
      assert.ok(m.quant.trim().length > 0, `${m.id}: quant`)
      if (m.activeParamsB !== undefined) {
        assert.ok(m.activeParamsB > 0 && m.activeParamsB <= m.paramsB, `${m.id}: activeParamsB`)
      }
    }
  })

  it('only tags models with roles that exist in the registry', () => {
    const roles = new Set<string>(AGENT_ROLE_IDS)
    for (const m of LOCAL_MODEL_CATALOG) {
      assert.ok(m.bestForRoles.length > 0, `${m.id}: bestForRoles must be non-empty`)
      for (const role of m.bestForRoles) {
        assert.ok(roles.has(role), `${m.id}: unknown role '${role}'`)
      }
    }
  })

  it('stores every present benchmark score with a source and date (no bare guesses)', () => {
    const known = new Set<Benchmark>(BENCHMARKS)
    for (const m of LOCAL_MODEL_CATALOG) {
      for (const [bench, score] of Object.entries(m.benchmarks)) {
        assert.ok(known.has(bench as Benchmark), `${m.id}: unknown benchmark '${bench}'`)
        assert.ok(Number.isFinite(score.value), `${m.id}/${bench}: value`)
        assert.ok(score.source.trim().length > 0, `${m.id}/${bench}: source required`)
        assert.ok(score.asOf.trim().length > 0, `${m.id}/${bench}: asOf required`)
      }
    }
  })

  it('looks up by id and returns null for unknown ids', () => {
    assert.equal(
      getLocalModelCapability(LOCAL_MODEL_CATALOG[0]?.id ?? '')?.id,
      LOCAL_MODEL_CATALOG[0]?.id,
    )
    assert.equal(getLocalModelCapability('not-a-model'), null)
  })

  it('recommends only budget-fitting models that advertise the role', () => {
    const recs = recommendLocalModelsForRole('coder', { maxDownloadGb: 20 })
    assert.ok(recs.length > 0)
    for (const m of recs) {
      assert.ok(m.downloadGb <= 20, `${m.id} exceeds budget`)
      assert.ok(m.bestForRoles.includes('coder'), `${m.id} not a coder`)
    }
    // The 22 GB all-rounder is excluded by the 20 GB budget.
    assert.ok(!recs.some((m) => m.id === 'qwen/qwen3.6-35b-a3b'))
  })

  it('is deterministic and falls back to catalog order when no scores are sourced', () => {
    const a = recommendLocalModelsForRole('coder')
    const b = recommendLocalModelsForRole('coder')
    assert.deepEqual(
      a.map((m) => m.id),
      b.map((m) => m.id),
    )
    // With no sourced scores, order follows the catalog's declared order.
    const catalogOrder = LOCAL_MODEL_CATALOG.filter((m) => m.bestForRoles.includes('coder')).map(
      (m) => m.id,
    )
    assert.deepEqual(
      a.map((m) => m.id),
      catalogOrder,
    )
  })

  it('returns nothing for an impossible budget', () => {
    assert.deepEqual(recommendLocalModelsForRole('coder', { maxDownloadGb: 0.1 }), [])
  })
})
