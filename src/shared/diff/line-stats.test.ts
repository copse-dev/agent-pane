import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeLineDiffStats } from './line-stats.ts'

describe('computeLineDiffStats', () => {
  it('counts new file lines as additions', () => {
    assert.deepEqual(computeLineDiffStats('', 'a\nb\n'), { additions: 2, deletions: 0 })
  })

  it('counts removed lines as deletions', () => {
    assert.deepEqual(computeLineDiffStats('a\nb\n', ''), { additions: 0, deletions: 2 })
  })

  it('counts replaced lines as add + delete', () => {
    assert.deepEqual(computeLineDiffStats('old\n', 'new\n'), { additions: 1, deletions: 1 })
  })

  it('reports zero when content is unchanged', () => {
    assert.deepEqual(computeLineDiffStats('same\n', 'same\n'), { additions: 0, deletions: 0 })
  })
})
