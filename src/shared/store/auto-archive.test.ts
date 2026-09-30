import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, selectAutoArchivable, type AutoArchiveCandidate } from './auto-archive.ts'

const NOW = 100 * DAY_MS
const options = { now: NOW, afterMs: 7 * DAY_MS }

function candidate(overrides: Partial<AutoArchiveCandidate> = {}): AutoArchiveCandidate {
  return {
    id: 't',
    prStates: ['merged'],
    lastActivityAt: NOW - 8 * DAY_MS,
    running: false,
    active: false,
    needsAttention: false,
    pendingStagedDiffs: 0,
    changedFiles: 0,
    unpushedCommits: 0,
    ...overrides,
  }
}

describe('selectAutoArchivable', () => {
  it('archives a merged, clean, idle thread', () => {
    assert.deepEqual(selectAutoArchivable([candidate()], options), ['t'])
  })

  it('waits out the delay, inclusive at the boundary', () => {
    const at = (age: number): AutoArchiveCandidate => candidate({ lastActivityAt: NOW - age })
    assert.deepEqual(selectAutoArchivable([at(7 * DAY_MS - 1)], options), [])
    assert.deepEqual(selectAutoArchivable([at(7 * DAY_MS)], options), ['t'])
  })

  it('is off when the delay is zero or negative', () => {
    assert.deepEqual(selectAutoArchivable([candidate()], { ...options, afterMs: 0 }), [])
    assert.deepEqual(selectAutoArchivable([candidate()], { ...options, afterMs: -1 }), [])
  })

  const leftAlone: [string, Partial<AutoArchiveCandidate>][] = [
    ['no PR', { prStates: [] }],
    ['an open PR', { prStates: ['open'] }],
    ['a closed-unmerged PR', { prStates: ['closed'] }],
    ['an unknown PR state', { prStates: ['unknown'] }],
    ['one merged and one open PR', { prStates: ['merged', 'open'] }],
    ['a running turn', { running: true }],
    ['being the active thread', { active: true }],
    ['something awaiting the user', { needsAttention: true }],
    ['pending proposed diffs', { pendingStagedDiffs: 1 }],
    ['an unknown staged-diff count', { pendingStagedDiffs: null }],
    ['uncommitted files', { changedFiles: 2 }],
    ['an unknown worktree state', { changedFiles: null }],
    ['unpushed commits', { unpushedCommits: 1 }],
    ['an unknown upstream', { unpushedCommits: null }],
    ['already being archived', { archivedAt: 1 }],
  ]
  for (const [name, overrides] of leftAlone) {
    it(`leaves a thread alone with ${name}`, () => {
      assert.deepEqual(selectAutoArchivable([candidate(overrides)], options), [])
    })
  }

  it('picks only the eligible threads out of a list', () => {
    const ids = selectAutoArchivable(
      [candidate({ id: 'a' }), candidate({ id: 'b', changedFiles: 1 }), candidate({ id: 'c' })],
      options,
    )
    assert.deepEqual(ids, ['a', 'c'])
  })
})
