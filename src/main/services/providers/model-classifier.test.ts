import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyModelForTask, suggestRoleForTask } from './model-classifier.ts'

describe('model-classifier', () => {
  it('routes trivial mechanical edits to the fast tier', () => {
    const rec = classifyModelForTask({ task: 'Rename the variable foo to bar' })
    assert.equal(rec.tier, 'fast')
    assert.equal(rec.model, 'claude-haiku-4-5')
  })

  it('routes design/refactor work to the frontier tier', () => {
    const rec = classifyModelForTask({
      task: 'Refactor the architecture of the agent loop to fix a race condition in concurrent tool calls',
    })
    assert.equal(rec.tier, 'frontier')
    assert.equal(rec.model, 'claude-opus-4-8')
  })

  it('defaults to the balanced tier when there are no strong signals', () => {
    const rec = classifyModelForTask({ task: 'Update the changelog with the new entries listed' })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.model, 'claude-sonnet-4-6')
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
