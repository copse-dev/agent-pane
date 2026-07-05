import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileChangesSuggestion } from './changes-stat.ts'
import { DETERMINISTIC_FOLLOW_UP_IDS } from './presets.ts'
import type { FollowUpSuggestion } from './types.ts'

const changesChip = (additions: number, deletions: number): FollowUpSuggestion => ({
  id: DETERMINISTIC_FOLLOW_UP_IDS.changes,
  label: 'Changes',
  prompt: 'p',
  variant: 'changes',
  additions,
  deletions,
})

const other = (id: string): FollowUpSuggestion => ({ id, label: id, prompt: id })

describe('reconcileChangesSuggestion', () => {
  it('updates stale counts in place', () => {
    const before = [changesChip(40, 12), other('run-tests')]
    const after = reconcileChangesSuggestion(before, { additions: 3, deletions: 1 })
    assert.notEqual(after, before)
    assert.equal(after.at(0)?.additions, 3)
    assert.equal(after.at(0)?.deletions, 1)
    assert.equal(after.at(1)?.id, 'run-tests')
  })

  it('returns the same reference when counts are unchanged', () => {
    const before = [changesChip(5, 2)]
    const after = reconcileChangesSuggestion(before, { additions: 5, deletions: 2 })
    assert.equal(after, before)
  })

  it('drops the chip when the tree is clean', () => {
    const before = [changesChip(5, 2), other('explain')]
    const after = reconcileChangesSuggestion(before, null)
    assert.deepEqual(
      after.map((s) => s.id),
      ['explain'],
    )
  })

  it('is a no-op when clean and no chip present', () => {
    const before = [other('explain')]
    const after = reconcileChangesSuggestion(before, null)
    assert.equal(after, before)
  })

  it('inserts the chip at the front when changes appear', () => {
    const before = [other('run-tests')]
    const after = reconcileChangesSuggestion(before, { additions: 8, deletions: 0 })
    assert.equal(after.at(0)?.id, DETERMINISTIC_FOLLOW_UP_IDS.changes)
    assert.equal(after.at(0)?.variant, 'changes')
    assert.equal(after.at(1)?.id, 'run-tests')
  })

  it('caps the list when inserting a new chip', () => {
    const before = [other('a'), other('b'), other('c')]
    const after = reconcileChangesSuggestion(before, { additions: 1, deletions: 1 }, 3)
    assert.equal(after.length, 3)
    assert.equal(after.at(0)?.id, DETERMINISTIC_FOLLOW_UP_IDS.changes)
    assert.equal(after.at(2)?.id, 'b')
  })
})
