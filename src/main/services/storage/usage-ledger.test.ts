import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { at } from '@shared/array-utils.ts'
import type { Thread } from '@shared/types'
import { storageSet } from './storage.ts'
import { setSetting } from './settings.ts'
import { OPENROUTER_PRICING_KEY } from '../providers/model-pricing-store.ts'
import { getUsageSummary, recordUsageEvent } from './usage-ledger.ts'
import { USAGE_EVENTS_STORAGE_KEY } from '@shared/usage/usage-event.ts'
import { saveProjectThread } from '../thread-store.ts'

describe('usage ledger', () => {
  it('persists events and exposes them in day/month summaries', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('activeProjectId', 'proj-1')
    storageSet('projects', [{ id: 'proj-1', path: '/tmp', name: 'tmp' }])
    storageSet('threads:proj-1', [])

    recordUsageEvent({
      model: 'claude-sonnet-4-6',
      source: 'agent',
      inputTokens: 500,
      outputTokens: 50,
      threadId: 'thread-1',
      projectId: 'proj-1',
    })

    const summary = await getUsageSummary()
    assert.equal(summary.ledgerEventCount, 1)
    assert.equal(summary.day.cloudModels.length, 1)
    assert.equal(summary.day.cloudModels[0]?.inputTokens, 500)
    assert.equal(summary.month.cloudModels[0]?.outputTokens, 50)
    assert.equal(summary.allTime.totalInputTokens, 0)
  })

  it('prices OpenRouter turns from the persisted catalog rates', async () => {
    // Regression: an `openrouter:` selection matched neither pricing source, so
    // the ledger reported $0.00 for real, billed OpenRouter usage.
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    await setSetting(OPENROUTER_PRICING_KEY, {
      'openrouter:z-ai/glm-5.2': { inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 },
    })
    recordUsageEvent({
      model: 'openrouter:z-ai/glm-5.2',
      source: 'agent',
      inputTokens: 3_600_000,
      outputTokens: 44_100,
      threadId: 'thread-or',
    })

    const summary = await getUsageSummary()
    const row = at(summary.day.cloudModels, 0)
    assert.equal(row.model, 'openrouter:z-ai/glm-5.2')
    assert.equal(row.isLocal, false)
    assert.ok(
      row.estimatedCostUsd > 1.5,
      `expected a real cost, got ${String(row.estimatedCostUsd)}`,
    )
    assert.equal(summary.day.totalCostUsd, row.estimatedCostUsd)
  })

  it('records local lmstudio models in day summaries', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    recordUsageEvent({
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
      source: 'agent',
      inputTokens: 1200,
      outputTokens: 300,
      threadId: 'thread-2',
    })
    const summary = await getUsageSummary()
    assert.equal(summary.day.localModels.length, 1)
    assert.equal(at(summary.day.localModels, 0).model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(at(summary.day.localModels, 0).estimatedCostUsd, 0)
  })

  it('keeps distinct calls with identical token counts', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    const input = {
      model: 'gpt-4o',
      source: 'agent' as const,
      inputTokens: 100,
      outputTokens: 20,
      threadId: 't1',
    }
    recordUsageEvent(input)
    recordUsageEvent(input)
    assert.equal((await getUsageSummary()).ledgerEventCount, 2)
  })

  it('builds all-time totals from metadata without reading transcript bodies (#1154)', async () => {
    const previousRoot = process.env['COPSE_WORKSPACE_DIR']
    const root = mkdtempSync(join(tmpdir(), 'copse-usage-metadata-'))
    const projectId = 'usage-metadata-project'
    const thread: Thread = {
      id: 'usage-metadata-thread',
      title: 'Usage metadata',
      status: 'idle',
      messages: [
        {
          id: 'missing-message',
          role: 'user',
          content: 'This body will be removed after the metadata is saved.',
          toolCalls: [],
          createdAt: 1,
        },
      ],
      usage: {
        inputTokens: 123,
        outputTokens: 45,
        byModel: {
          'claude-sonnet-4-6': { inputTokens: 123, outputTokens: 45 },
        },
      },
      createdAt: 1,
      updatedAt: 1,
    }
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('projects', [{ id: projectId, path: root, name: 'usage metadata' }])
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])

    try {
      await saveProjectThread(projectId, thread)
      rmSync(join(root, projectId, thread.id, 'messages', 'missing-message.md'))

      const summary = await getUsageSummary()

      assert.equal(summary.allTime.totalInputTokens, 123)
      assert.equal(summary.allTime.totalOutputTokens, 45)
    } finally {
      rmSync(root, { recursive: true, force: true })
      if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    }
  })
})
