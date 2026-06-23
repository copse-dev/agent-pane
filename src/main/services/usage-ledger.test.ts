import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { storageSet } from './storage.ts'
import { getUsageSummary, recordUsageEvent } from './usage-ledger.ts'
import { USAGE_EVENTS_STORAGE_KEY } from '@shared/usage/usage-event.ts'

describe('usage ledger', () => {
  it('persists events and exposes them in day/month summaries', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('activeProjectId', 'proj-1')
    storageSet('projects', [{ id: 'proj-1', path: '/tmp', name: 'tmp' }])
    storageSet('threads:proj-1', [])

    await recordUsageEvent({
      model: 'claude-sonnet-4-6',
      source: 'agent',
      inputTokens: 500,
      outputTokens: 50,
      threadId: 'thread-1',
      projectId: 'proj-1',
    })

    const summary = getUsageSummary()
    assert.equal(summary.day.cloudModels.length, 1)
    assert.equal(summary.day.cloudModels[0]!.inputTokens, 500)
    assert.equal(summary.month.cloudModels[0]!.outputTokens, 50)
    assert.equal(summary.allTime.totalInputTokens, 0)
  })
})
