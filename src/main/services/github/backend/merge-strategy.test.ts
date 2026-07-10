import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAutoMergeStrategy } from './merge-strategy.ts'

describe('chooseAutoMergeStrategy', () => {
  it('prefers squash → merge → rebase', () => {
    assert.equal(chooseAutoMergeStrategy({ squash: true, merge: true, rebase: true }), 'squash')
    assert.equal(chooseAutoMergeStrategy({ squash: false, merge: true, rebase: true }), 'merge')
    assert.equal(chooseAutoMergeStrategy({ squash: false, merge: false, rebase: true }), 'rebase')
  })

  it('returns null when the repo permits no merge method', () => {
    assert.equal(chooseAutoMergeStrategy({ squash: false, merge: false, rebase: false }), null)
  })

  it('optimistically defaults to squash when the config is unknown', () => {
    assert.equal(chooseAutoMergeStrategy({}), 'squash')
  })
})
