import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getModelInfo, TRACKED_MODELS } from '@copse/llm/model-catalog.ts'
import { intellectBand, modelIntellect } from '@copse/llm/model-intellect.ts'
import {
  BAND_CANDIDATES,
  classifyModelForTask,
  groupModelsByIntellectBand,
  modelUsdPerMTok,
  pickCheapestFittingModel,
  suggestRoleForTask,
} from './model-classifier.ts'

describe('model-classifier', () => {
  it('routes trivial mechanical edits to the low band', () => {
    const rec = classifyModelForTask({ task: 'Rename the variable foo to bar' })
    assert.equal(rec.band, 'low')
    // Derived rather than hardcoded, matching the mid/top cases below: which
    // model is cheapest in a band is a fact about the synced catalog, not a
    // contract of the classifier. Naming one here means every catalog addition
    // breaks this test for no behavioural reason.
    assert.equal(
      rec.model,
      pickCheapestFittingModel(BAND_CANDIDATES.low, 0, 'claude-haiku-4-5').model,
    )
    assert.match(rec.rationale, /cost-aware pick/)
    assert.ok(rec.usdPerMTok !== null && rec.usdPerMTok > 0)
  })

  it('routes design/refactor work to the top band', () => {
    const rec = classifyModelForTask({
      task: 'Refactor the architecture of the agent loop to fix a race condition in concurrent tool calls',
    })
    assert.equal(rec.band, 'top')
    assert.equal(
      rec.model,
      pickCheapestFittingModel(BAND_CANDIDATES.top, 0, 'claude-fable-5').model,
    )
  })

  it('defaults to the mid band when there are no strong signals', () => {
    const rec = classifyModelForTask({ task: 'Update the changelog with the new entries listed' })
    assert.equal(rec.band, 'mid')
    assert.equal(
      rec.model,
      pickCheapestFittingModel(BAND_CANDIDATES.mid, 0, 'claude-sonnet-5').model,
    )
  })

  it('bands fixture scores and excludes unmeasured models', () => {
    const fixtureScale = [3, 4, 5, 6, 6, 8, 9]
    const fixtureScores = new Map<string, number>([
      ['fixture-low', 3],
      ['fixture-mid', 6],
      ['fixture-top', 9],
    ])
    const grouped = groupModelsByIntellectBand(
      ['fixture-low', 'fixture-mid', 'fixture-top', 'fixture-unmeasured'],
      (model) => fixtureScores.get(model) ?? null,
      fixtureScale,
    )
    assert.deepEqual(grouped, {
      low: ['fixture-low'],
      mid: ['fixture-mid'],
      top: ['fixture-top'],
    })
  })

  it('bands the live catalog from its current synced scores', () => {
    const candidates = new Set(Object.values(BAND_CANDIDATES).flat())
    for (const model of TRACKED_MODELS) {
      const intellect = modelIntellect(model)
      if (intellect === null) {
        assert.equal(candidates.has(model), false, `${model} is unmeasured`)
        continue
      }
      const band = intellectBand(intellect)
      assert.equal(BAND_CANDIDATES[band].includes(model), true, `${model} belongs in ${band}`)
    }
  })

  it("reports the representative model's intellect from the shared scale", () => {
    const rec = classifyModelForTask({ task: 'Rename the variable foo to bar' })
    // The claim is that the number comes from the one shared scale for the
    // model actually picked — not that any particular value is hardcoded here.
    assert.equal(rec.intellect, modelIntellect(rec.model))
  })

  it('prefers a wider-context candidate within the same band', () => {
    // Above the 272k window of the cheapest low-band models, so the estimate
    // genuinely forces the pick onto a wider-context candidate.
    const contextTokensEstimate = 300_000
    const rec = classifyModelForTask({
      task: 'Rename a symbol across the repo',
      contextTokensEstimate,
    })
    assert.equal(rec.band, 'low')
    // Assert the property, not the identity: the pick must actually hold the
    // estimated context. Several low-band models have a window this wide, and
    // which of them is cheapest shifts as the catalog is synced.
    const info = getModelInfo(rec.model)
    assert.ok(info, `${rec.model} should be in the catalog`)
    assert.ok(
      info.contextWindow >= contextTokensEstimate,
      `${rec.model} has a ${String(info.contextWindow)}-token window, too small for ${String(contextTokensEstimate)}`,
    )
    // ...and it must have moved off the unconstrained pick, whose window is narrower.
    const unconstrained = classifyModelForTask({ task: 'Rename a symbol across the repo' })
    assert.notEqual(rec.model, unconstrained.model)
  })

  it('flags when the estimated context exceeds the chosen model window', () => {
    const rec = classifyModelForTask({ task: 'Rename a symbol', contextTokensEstimate: 5_000_000 })
    assert.match(rec.rationale, /exceeds/)
  })

  it('produces a confidence in [0, 1]', () => {
    const rec = classifyModelForTask({ task: 'Plan the migration and redesign the storage layer' })
    assert.ok(rec.confidence >= 0 && rec.confidence <= 1)
  })
})

describe('pickCheapestFittingModel', () => {
  it('ranks by combined catalog USD/MTok among models that fit', () => {
    const pick = pickCheapestFittingModel(BAND_CANDIDATES.low, 0, 'claude-haiku-4-5')
    const expected = BAND_CANDIDATES.low
      .map((model) => ({ model, usdPerMTok: modelUsdPerMTok(model) }))
      .filter((candidate) => candidate.usdPerMTok !== null)
      .toSorted((left, right) => (left.usdPerMTok ?? Infinity) - (right.usdPerMTok ?? Infinity))[0]
    assert.ok(expected)
    assert.deepEqual({ model: pick.model, usdPerMTok: pick.usdPerMTok }, expected)
  })
})

describe('suggestRoleForTask', () => {
  it('maps tasks to their pipeline role by keyword', () => {
    assert.equal(
      suggestRoleForTask('Find any security vulnerabilities in the auth flow').role,
      'security-auditor',
    )
    assert.equal(suggestRoleForTask('Write unit tests for the parser').role, 'test-gen')
    assert.equal(suggestRoleForTask('Review this diff for maintainability').role, 'reviewer')
    assert.equal(
      suggestRoleForTask('Refactor and rename a function without changing behaviour').role,
      'refactor',
    )
    assert.equal(
      suggestRoleForTask('Debug why the build is failing at the root cause').role,
      'debugger',
    )
    assert.equal(suggestRoleForTask('Document the API in the README').role, 'docs')
    assert.equal(suggestRoleForTask('Plan the migration and break this down').role, 'planner')
  })

  it('defaults to the coder role when no signal matches', () => {
    const rec = suggestRoleForTask('Add a new endpoint that returns the user profile')
    assert.equal(rec.role, 'coder')
    assert.match(rec.rationale, /default/)
  })

  it('returns a human label for the role', () => {
    assert.equal(suggestRoleForTask('Review this PR').label, 'Reviewer')
  })
})
