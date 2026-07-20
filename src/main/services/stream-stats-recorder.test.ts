import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginHookRunRecording, endHookRunRecording } from './hook-run-recorder.ts'
import { getThreadMeta } from './thread-store.ts'
import { recordStreamCut } from './stream-stats-recorder.ts'
import type { StreamCutRecord } from '@copse/agent/stream-cut-record.ts'
import { storageSet } from './storage/storage.ts'

const PROJECT = 'proj-stream-stats'
const THREAD = 'thread-stream-stats'

function sampleCut(overrides: Partial<StreamCutRecord> = {}): StreamCutRecord {
  return {
    step: 1,
    cutReason: 'reasoning_runaway_cap',
    streamOutputChars: 128_000,
    streamReasoningChars: 120_000,
    reasoningText: 'Actually, I just realized I should check the tests again.',
    reasoningTextTruncated: false,
    hasToolCalls: false,
    toolCallCount: 0,
    stopReason: 'max_tokens',
    streamCappedAsRunaway: true,
    reasoningRunawayStreak: 0,
    willInjectReasoningRunawayNudge: true,
    ...overrides,
  }
}

describe('stream-stats-recorder', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-stream-stats-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('activeProjectId', PROJECT)
  })

  afterEach(() => {
    endHookRunRecording(THREAD)
    storageSet('activeProjectId', null)
    rmSync(root, { recursive: true, force: true })
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
  })

  it('appends a stream cut line under the project workspace dir', async () => {
    beginHookRunRecording(THREAD)
    try {
      recordStreamCut(sampleCut(), 'lmstudio:qwen/qwen3.6-35b-a3b')
    } finally {
      endHookRunRecording(THREAD)
    }

    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    const statsPath = join(root, PROJECT, 'stream-stats.jsonl')
    const raw = readFileSync(statsPath, 'utf8').trim()
    const line = JSON.parse(raw) as Record<string, unknown>
    assert.equal(line['schemaVersion'], 1)
    assert.equal(line['threadId'], THREAD)
    assert.equal(line['model'], 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(line['cutReason'], 'reasoning_runaway_cap')
    assert.equal(line['reasoningText'], sampleCut().reasoningText)
    assert.equal(line['willInjectReasoningRunawayNudge'], true)
    assert.equal(line['totalTokensEstimate'], 32_000)
    assert.equal(line['reasoningTokensEstimate'], 30_000)
  })

  it('no-ops when no hook-run recording context is active', async () => {
    recordStreamCut(sampleCut(), 'mock-model')
    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    const statsPath = join(root, PROJECT, 'stream-stats.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.throws(() => readFileSync(statsPath, 'utf8'))
  })
})
