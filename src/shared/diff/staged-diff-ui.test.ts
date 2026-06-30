import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActiveDiff, StagedDiffEntry } from '@shared/types/state.ts'
import {
  pruneStagedDiffCache,
  resolveStagedDiffView,
  shouldJumpToProposed,
} from './staged-diff-ui.ts'

const diff = (path: string): ActiveDiff => ({
  path,
  before: 'a',
  after: 'b',
  language: 'typescript',
})

describe('pruneStagedDiffCache', () => {
  it('drops cache entries no longer in the queue', () => {
    const cache = new Map<string, ActiveDiff>([
      ['a.ts', diff('a.ts')],
      ['b.ts', diff('b.ts')],
    ])
    const entries: StagedDiffEntry[] = [{ path: 'b.ts', language: 'typescript' }]
    pruneStagedDiffCache(cache, entries)
    assert.equal(cache.has('a.ts'), false)
    assert.equal(cache.has('b.ts'), true)
  })
})

describe('resolveStagedDiffView', () => {
  const entries: StagedDiffEntry[] = [
    { path: 'a.ts', language: 'typescript' },
    { path: 'b.ts', language: 'typescript' },
  ]
  const cache = new Map<string, ActiveDiff>([
    ['a.ts', diff('a.ts')],
    ['b.ts', diff('b.ts')],
  ])

  it('prefers an explicit selection', () => {
    assert.equal(resolveStagedDiffView(entries, cache, 'b.ts', diff('a.ts'))?.path, 'b.ts')
  })

  it('falls back to activeDiff when it is still queued', () => {
    assert.equal(resolveStagedDiffView(entries, cache, null, diff('a.ts'))?.path, 'a.ts')
  })

  it('uses the first queued file when activeDiff is stale', () => {
    assert.equal(resolveStagedDiffView(entries, cache, null, diff('gone.ts'))?.path, 'a.ts')
  })
})

describe('shouldJumpToProposed', () => {
  const entries: StagedDiffEntry[] = [
    { path: 'a.ts', language: 'typescript' },
    { path: 'b.ts', language: 'typescript' },
  ]

  it('jumps to a freshly proposed path that is queued', () => {
    assert.equal(shouldJumpToProposed('b.ts', entries), true)
  })

  it('does not jump when there is no pending proposal', () => {
    assert.equal(shouldJumpToProposed(null, entries), false)
  })

  it('waits (no jump) until the proposed path is in the queue', () => {
    // agent:show_diff arrives before diff:queued, so the path may not be queued yet.
    assert.equal(shouldJumpToProposed('c.ts', entries), false)
  })
})
