import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSpecialistCheckBudget,
  parseSpecialistCheckResult,
  specialistCheckDefinition,
  specialistCheckRequestSchema,
} from './specialist-checks.ts'

describe('specialist checks', () => {
  it('caps all checks across one review and rejects duplicates', () => {
    const definition = specialistCheckDefinition('high-risk-impact')
    assert.ok(definition)
    const budget = createSpecialistCheckBudget(3)
    const request = specialistCheckRequestSchema.parse({
      checkId: definition.id,
      question: 'Can data cross workspace boundaries?',
      startingPaths: ['src/cache.ts'],
    })
    assert.deepEqual(budget.tryReserve(request, definition), { allowed: true })
    const duplicate = budget.tryReserve(request, definition)
    assert.equal(duplicate.allowed, false)
    assert.match(duplicate.reason, /already investigated/)
    for (const question of ['Question two?', 'Question three?']) {
      assert.deepEqual(budget.tryReserve({ ...request, question }, definition), { allowed: true })
    }
    assert.equal(budget.remaining(), 0)
    const fourth = budget.tryReserve({ ...request, question: 'Question four?' }, definition)
    assert.equal(fourth.allowed, false)
    assert.match(fourth.reason, /limit reached/)
  })

  it('parses evidence and fails malformed output closed as inconclusive', () => {
    const parsed = parseSpecialistCheckResult(
      'Evidence gathered.\nSPECIALIST_JSON: {"status":"supported","claim":"Leak","evidence":[],"causalChain":[],"counterEvidence":[],"missingEvidence":[],"confidence":0.8}',
    )
    assert.equal(parsed.status, 'supported')
    assert.equal(parsed.claim, 'Leak')
    const malformed = parseSpecialistCheckResult('SPECIALIST_JSON: nope')
    assert.equal(malformed.status, 'inconclusive')
    assert.equal(malformed.confidence, 0)
  })
})
