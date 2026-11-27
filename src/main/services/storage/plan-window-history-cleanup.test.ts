import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { storageDelete, storageGet, storageSet } from './storage.ts'
import { getSetting, setSetting } from './settings.ts'
import { removeOrphanedPlanWindowHistory } from './plan-window-history-cleanup.ts'

const HISTORY_KEY = 'planWindowHistory'
const DONE_KEY = 'planWindowHistoryCleanupDone'

/** A ledger as the collector removed in #4048 wrote it. */
const retiredHistory = {
  samples: [
    {
      at: 1_763_000_000_000,
      provider: 'claude',
      planLabel: 'Max',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 42, resetsAt: null }],
    },
  ],
  completed: [
    {
      provider: 'claude',
      windowId: 'weekly',
      label: 'Weekly',
      usedPercent: 97,
      endedResetsAt: '2026-11-01T00:00:00.000Z',
      completedAt: 1_762_000_000_000,
    },
  ],
}

function reset(): void {
  storageDelete(HISTORY_KEY)
  storageDelete(DONE_KEY)
}

describe('removeOrphanedPlanWindowHistory', () => {
  beforeEach(reset)
  afterEach(reset)

  it('removes a ledger in the retired shape and records that it ran', () => {
    storageSet(HISTORY_KEY, retiredHistory)
    removeOrphanedPlanWindowHistory()
    assert.equal(storageGet(HISTORY_KEY), undefined)
    assert.equal(storageGet(DONE_KEY), true)
  })

  it('removes an empty ledger the old collector left behind', () => {
    storageSet(HISTORY_KEY, { samples: [], completed: [] })
    removeOrphanedPlanWindowHistory()
    assert.equal(storageGet(HISTORY_KEY), undefined)
  })

  it('leaves unrelated storage and settings untouched', async () => {
    storageSet(HISTORY_KEY, retiredHistory)
    storageSet('storageRetention', { enabled: true, days: 30 })
    await setSetting('theme', 'dark')
    removeOrphanedPlanWindowHistory()
    assert.deepEqual(storageGet('storageRetention'), { enabled: true, days: 30 })
    assert.equal(getSetting('theme', 'light'), 'dark')
    storageDelete('storageRetention')
  })

  for (const [name, value] of [
    ['an extra top-level field', { ...retiredHistory, version: 2 }],
    ['a missing field', { samples: retiredHistory.samples }],
    ['a non-array field', { samples: [], completed: {} }],
    ['a sample without a timestamp', { samples: [{ provider: 'claude' }], completed: [] }],
    ['a completed window without an id', { samples: [], completed: [{ completedAt: 1 }] }],
    ['a non-record value', ['samples', 'completed']],
  ] as const) {
    it(`keeps a value with ${name}, and does not revisit it later`, () => {
      storageSet(HISTORY_KEY, value)
      removeOrphanedPlanWindowHistory()
      assert.deepEqual(storageGet(HISTORY_KEY), value)
      assert.equal(storageGet(DONE_KEY), true)
    })
  }

  it('runs only once per profile', () => {
    removeOrphanedPlanWindowHistory()
    assert.equal(storageGet(DONE_KEY), true)
    // A ledger appearing after the cleanup (e.g. a downgrade writing it again)
    // is not deleted by a later launch.
    storageSet(HISTORY_KEY, retiredHistory)
    removeOrphanedPlanWindowHistory()
    assert.deepEqual(storageGet(HISTORY_KEY), retiredHistory)
  })
})
