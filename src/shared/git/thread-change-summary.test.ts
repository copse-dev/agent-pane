import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeThreadChanges, sameThreadChangeSummary } from './thread-change-summary.ts'

describe('describeThreadChanges', () => {
  it('says nothing for a clean or unreadable thread', () => {
    assert.equal(describeThreadChanges(null), null)
    assert.equal(describeThreadChanges({ dirty: false }), null)
  })

  it('describes unpushed commits with singular and plural', () => {
    assert.equal(describeThreadChanges({ dirty: false, unpushed: 1 }), '1 unpushed commit')
    assert.equal(describeThreadChanges({ dirty: false, unpushed: 3 }), '3 unpushed commits')
  })

  it('describes a dirty tree, alone or with commits', () => {
    assert.equal(describeThreadChanges({ dirty: true }), 'Uncommitted changes')
    assert.equal(
      describeThreadChanges({ dirty: true, unpushed: 2 }),
      '2 unpushed commits and uncommitted changes',
    )
  })

  it('compares by what the row would show', () => {
    assert.equal(sameThreadChangeSummary({ dirty: false }, null), true)
    assert.equal(sameThreadChangeSummary({ dirty: true }, { dirty: false, unpushed: 1 }), false)
  })
})
