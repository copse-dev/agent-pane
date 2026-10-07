import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { at } from '@shared/array-utils.ts'
import type { Thread } from '@shared/types'
import {
  storageGet,
  storageListFiles,
  storageReadFile,
  storageSet,
  storageWriteFile,
} from './storage.ts'
import { setSetting } from './settings.ts'
import { OPENROUTER_PRICING_KEY } from '../providers/model-pricing-store.ts'
import {
  getUsageSummary,
  readUsageEvents,
  recordAgentUsageChunk,
  recordUsageEvent,
} from './usage-ledger.ts'
import {
  LEGACY_USAGE_EVENTS_STORAGE_KEY,
  USAGE_EVENTS_DIR,
  USAGE_EVENTS_MIGRATED_FILE,
} from '@shared/usage/usage-event.ts'
import { clearUsageLedger } from './usage-ledger.test-support.ts'
import { saveProjectThread } from '../thread-store.ts'

describe('usage ledger', () => {
  it('persists events and exposes them in day/month summaries', async () => {
    await clearUsageLedger()
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
    await clearUsageLedger()
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

  it('keeps the router-reported hosting provider on each call, across later appends', async () => {
    // Prompt caches live per upstream, so the provider that served each call is
    // what tells a routing switch apart from a request-bytes cache miss.
    await clearUsageLedger()
    recordAgentUsageChunk('thread-or', {
      type: 'usage',
      model: 'openrouter:moonshotai/kimi-k3',
      inputTokens: 90_000,
      outputTokens: 400,
      cacheReadTokens: 0,
      hostingProvider: 'Moonshot AI',
    })
    // Every append re-parses the stored ledger, so the field must survive it.
    recordAgentUsageChunk('thread-or', {
      type: 'usage',
      model: 'openrouter:moonshotai/kimi-k3',
      inputTokens: 91_000,
      outputTokens: 300,
      cacheReadTokens: 89_000,
    })

    const events = await readUsageEvents()
    assert.deepEqual(
      events.map((e) => e.hostingProvider),
      ['Moonshot AI', undefined],
    )
  })

  it('records local lmstudio models in day summaries', async () => {
    await clearUsageLedger()
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
    await clearUsageLedger()
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

  it('keeps the ledger out of config.json', async () => {
    // Every storageSet rewrites the whole config file on the main thread, so a
    // ledger that grew there taxed every other write.
    await clearUsageLedger()
    recordUsageEvent({ model: 'gpt-4o', source: 'agent', inputTokens: 10, outputTokens: 5 })
    assert.equal(storageGet(LEGACY_USAGE_EVENTS_STORAGE_KEY), undefined)
    assert.equal((await readUsageEvents()).length, 1)
  })

  it('appends each day to its own file', async () => {
    await clearUsageLedger()
    const day = 24 * 60 * 60 * 1000
    const noon = Date.UTC(2026, 9, 5, 12)
    recordUsageEvent({ model: 'a', source: 'agent', inputTokens: 1, outputTokens: 1, at: noon })
    recordUsageEvent({ model: 'b', source: 'agent', inputTokens: 1, outputTokens: 1, at: noon + 1 })
    recordUsageEvent({
      model: 'c',
      source: 'agent',
      inputTokens: 1,
      outputTokens: 1,
      at: noon + day,
    })

    // Appends are asynchronous; a reader waits for the ones in flight.
    await readUsageEvents()
    assert.deepEqual((await storageListFiles(USAGE_EVENTS_DIR)).sort(), [
      '2026-10-05.jsonl',
      '2026-10-06.jsonl',
    ])
    const first = await storageReadFile(`${USAGE_EVENTS_DIR}/2026-10-05.jsonl`)
    assert.equal(first?.split('\n').filter((line) => line !== '').length, 2)
  })

  it('moves a ledger stored in config.json into a file, dropping expired events', async () => {
    await clearUsageLedger()
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    storageSet(LEGACY_USAGE_EVENTS_STORAGE_KEY, [
      { at: now - 120 * day, model: 'old-model', source: 'agent', inputTokens: 1, outputTokens: 1 },
      { at: now - day, model: 'kept-model', source: 'agent', inputTokens: 7, outputTokens: 3 },
    ])

    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['kept-model'],
    )
    assert.equal(storageGet(LEGACY_USAGE_EVENTS_STORAGE_KEY), undefined)
    assert.ok(
      (await storageListFiles(USAGE_EVENTS_DIR)).includes(USAGE_EVENTS_MIGRATED_FILE),
      'the old events are kept in their own file',
    )

    // New events land alongside the migrated ones, newest last.
    recordUsageEvent({ model: 'new-model', source: 'agent', inputTokens: 2, outputTokens: 2 })
    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['kept-model', 'new-model'],
    )
  })

  it('migrates before the first new event is recorded', async () => {
    await clearUsageLedger()
    storageSet(LEGACY_USAGE_EVENTS_STORAGE_KEY, [
      { at: Date.now() - 1_000, model: 'legacy', source: 'agent', inputTokens: 3, outputTokens: 3 },
    ])

    recordUsageEvent({ model: 'fresh', source: 'agent', inputTokens: 1, outputTokens: 1 })

    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['legacy', 'fresh'],
      'recording first must not make the migration skip the old events',
    )
  })

  it('finishes an interrupted migration by dropping the stale config key, not merging it', async () => {
    // The migrated file is written atomically before the key is deleted, so ledger
    // files that already exist are complete and newer than whatever the key holds.
    await clearUsageLedger()
    recordUsageEvent({ model: 'in-file', source: 'agent', inputTokens: 4, outputTokens: 4 })
    await readUsageEvents()
    storageSet(LEGACY_USAGE_EVENTS_STORAGE_KEY, [
      { at: Date.now(), model: 'stale-key', source: 'agent', inputTokens: 9, outputTokens: 9 },
    ])

    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['in-file'],
    )
    assert.equal(storageGet(LEGACY_USAGE_EVENTS_STORAGE_KEY), undefined)
  })

  it('skips a torn record and keeps appending after it', async () => {
    await clearUsageLedger()
    const at = Date.now()
    const good = { at, model: 'good', source: 'agent', inputTokens: 1, outputTokens: 1 }
    const file = `${USAGE_EVENTS_DIR}/${new Date(at).toISOString().slice(0, 10)}.jsonl`
    // A crash mid-append leaves a record without its closing brace and newline.
    await storageWriteFile(file, `\n${JSON.stringify(good)}\n{"at":1,"model":"to`)

    recordUsageEvent({ model: 'after-tear', source: 'agent', inputTokens: 2, outputTokens: 2, at })

    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['good', 'after-tear'],
    )
  })

  it('never reports an expired event, and deletes a day file once all of it has expired', async () => {
    await clearUsageLedger()
    const day = 24 * 60 * 60 * 1000
    const old = Date.now() - 200 * day
    const oldFile = `${USAGE_EVENTS_DIR}/${new Date(old).toISOString().slice(0, 10)}.jsonl`
    await storageWriteFile(
      oldFile,
      `\n${JSON.stringify({ at: old, model: 'expired', source: 'agent', inputTokens: 1, outputTokens: 1 })}`,
    )
    recordUsageEvent({ model: 'fresh', source: 'agent', inputTokens: 1, outputTokens: 1 })

    assert.deepEqual(
      (await readUsageEvents()).map((event) => event.model),
      ['fresh'],
    )
    assert.equal(
      (await storageListFiles(USAGE_EVENTS_DIR)).some((name) => oldFile.endsWith(name)),
      false,
      'the expired day file is removed',
    )
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
    await clearUsageLedger()

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
