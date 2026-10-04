import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { prHasMergeConflicts } from './pr-status.ts'

describe('known PR merge conflicts', () => {
  it('recognizes explicit mergeability and dirty merge state', () => {
    assert.equal(prHasMergeConflicts({ mergeable: 'CONFLICTING' }), true)
    assert.equal(prHasMergeConflicts({ mergeStateStatus: 'DIRTY' }), true)
    assert.equal(prHasMergeConflicts({ mergeStateStatus: 'conflicting' }), true)
  })
  it('does not treat unknown or other merge blockers as conflicts', () => {
    assert.equal(prHasMergeConflicts({}), false)
    assert.equal(prHasMergeConflicts({ mergeable: 'UNKNOWN' }), false)
    assert.equal(
      prHasMergeConflicts({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }),
      false,
    )
  })
})
