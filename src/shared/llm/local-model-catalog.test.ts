import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ROLE_IDS } from './agent-roles.ts'
import {
  BENCHMARKS,
  CORE_LOCAL_ROLES,
  HARDWARE_CLASSES,
  LOCAL_MODEL_CATALOG,
  getHardwareClass,
  getLocalModelCapability,
  recommendLocalModelsForRole,
  recommendedLocalSetup,
  recommendedSetupForClass,
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

  it('recommends a budget-fitting local setup covering the core roles', () => {
    const setup = recommendedLocalSetup({ maxDownloadGb: 64 })
    assert.deepEqual(
      setup.map((s) => s.role),
      [...CORE_LOCAL_ROLES],
    )
    for (const { role, model } of setup) {
      assert.ok(model.downloadGb <= 64)
      assert.ok(model.bestForRoles.includes(role), `${model.id} not fit for ${role}`)
    }
  })

  it('omits a core role that has no budget-fitting candidate rather than over-spending', () => {
    // A 3 GB budget fits only the smallest models; the coder picks all exceed it.
    const setup = recommendedLocalSetup({ maxDownloadGb: 3 })
    assert.ok(!setup.some((s) => s.role === 'coder'))
    for (const { model } of setup) assert.ok(model.downloadGb <= 3)
  })

  it('orders hardware classes by increasing memory and download budget', () => {
    for (let i = 1; i < HARDWARE_CLASSES.length; i++) {
      const prev = HARDWARE_CLASSES[i - 1]
      const cur = HARDWARE_CLASSES[i]
      assert.ok(prev && cur)
      assert.ok(cur.memoryGb > prev.memoryGb, `${cur.id} memory not increasing`)
      assert.ok(cur.maxDownloadGb > prev.maxDownloadGb, `${cur.id} budget not increasing`)
      // Budget leaves headroom below memory (except the unbounded server tier).
      if (Number.isFinite(cur.maxDownloadGb)) assert.ok(cur.maxDownloadGb < cur.memoryGb)
    }
  })

  it('sizes the recommended setup to the hardware class', () => {
    const compact = recommendedSetupForClass('compact')
    for (const { model } of compact)
      assert.ok(model.downloadGb <= 6, `${model.id} too big for compact`)
    // A bigger class fits at least as many roles as a smaller one.
    assert.ok(recommendedSetupForClass('workstation').length >= compact.length)
    assert.deepEqual(recommendedSetupForClass('not-a-class'), [])
  })

  it('resolves hardware classes by id', () => {
    assert.equal(getHardwareClass('standard')?.memoryGb, 16)
    assert.equal(getHardwareClass('nope'), null)
  })
})
