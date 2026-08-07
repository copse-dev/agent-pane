import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getModelInfo } from '@copse/llm/model-catalog.ts'
import { modelIntellect } from '@copse/llm/model-intellect.ts'
import {
  BAND_CANDIDATES,
  classifyModelForTask,
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

  it('bands the catalog exactly as the retired editorial scale did', () => {
    // Pins the behaviour-neutrality of moving banding onto the measured axis.
    // The two scales disagreed on 10 of 12 rank *positions*, but every model
    // lands in the same band, so routing is unchanged. If a future measurement
    // moves a model across a band boundary this fails, which is the point —
    // that is a routing change and should be seen, not absorbed silently.
    assert.deepEqual([...BAND_CANDIDATES.low].sort(), [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-5',
      'gpt-5-mini',
    ])
    assert.deepEqual([...BAND_CANDIDATES.mid].sort(), [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'gpt-5.5',
      'gpt-5.6-terra',
    ])
    assert.deepEqual([...BAND_CANDIDATES.top].sort(), ['claude-fable-5', 'gpt-5.6-sol'])
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
    // Named explicitly here because this test is the one asserting the ranking
    // itself — deriving the expectation from the function under test would be
    // circular.
    assert.equal(pick.model, 'gpt-4o-mini')
    assert.equal(pick.usdPerMTok, modelUsdPerMTok('gpt-4o-mini'))
  })

  it('will not pick a cheaper model that has no measured intellect', () => {
    // gpt-5-nano ($0.05 + $0.40) undercuts gpt-4o-mini ($0.15 + $0.60), so on
    // price alone it would win the low band outright. It has no Intelligence
    // Index reading, so it is not a candidate at all — "unknown" must never be
    // treated as "weakest", or the cheapest unmeasured model in the catalog
    // silently becomes the default for trivial work.
    const cheaper = modelUsdPerMTok('gpt-5-nano')
    const picked = modelUsdPerMTok('gpt-4o-mini')
    assert.ok(cheaper !== null && picked !== null && cheaper < picked)
    assert.equal(modelIntellect('gpt-5-nano'), null)
    for (const band of [BAND_CANDIDATES.low, BAND_CANDIDATES.mid, BAND_CANDIDATES.top]) {
      assert.ok(!band.includes('gpt-5-nano'), 'unmeasured model must not be a band candidate')
      assert.ok(!band.includes('gpt-5.6-luna'), 'unmeasured model must not be a band candidate')
    }
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
