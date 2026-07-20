import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.equal(rec.model, 'gpt-4o-mini')
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

  it("reports the representative model's intellect from the shared scale", () => {
    const rec = classifyModelForTask({ task: 'Rename the variable foo to bar' })
    assert.equal(rec.intellect, 3)
  })

  it('prefers a wider-context candidate within the same band', () => {
    const rec = classifyModelForTask({
      task: 'Rename a symbol across the repo',
      contextTokensEstimate: 200_000,
    })
    assert.equal(rec.band, 'low')
    assert.equal(rec.model, 'gpt-5-mini')
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
    assert.equal(pick.model, 'gpt-4o-mini')
    assert.equal(pick.usdPerMTok, modelUsdPerMTok('gpt-4o-mini'))
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
