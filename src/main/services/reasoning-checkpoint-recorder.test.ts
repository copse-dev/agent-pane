import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ReasoningCheckpointRecord } from '@copse/agent/reasoning-circle-detector.ts'
import { beginHookRunRecording, endHookRunRecording } from './hook-run-recorder.ts'
import { getThreadMeta } from './thread-store.ts'
import { recordReasoningCheckpoint } from './reasoning-checkpoint-recorder.ts'
import { storageSet } from './storage/storage.ts'

const PROJECT = 'proj-reasoning-checkpoints'
const THREAD = 'thread-reasoning-checkpoints'

const CHECKPOINT: ReasoningCheckpointRecord = {
  step: 1,
  checkpointTokens: 2_048,
  hardMaxTokens: 32_000,
  streamOutputChars: 8_192,
  streamReasoningChars: 8_100,
  visibleTextChars: 92,
  decision: 'continue',
  signals: [],
}

describe('reasoning-checkpoint-recorder', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-reasoning-checkpoints-'))
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

  it('appends checkpoint metadata without reasoning text', async () => {
    beginHookRunRecording(THREAD)
    try {
      recordReasoningCheckpoint(CHECKPOINT, 'lmstudio:qwen/qwen3.6-35b-a3b')
    } finally {
      endHookRunRecording(THREAD)
    }

    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    const raw = readFileSync(join(root, PROJECT, 'reasoning-checkpoints.jsonl'), 'utf8').trim()
    const line = JSON.parse(raw) as Record<string, unknown>
    assert.equal(line['schemaVersion'], 1)
    assert.equal(line['threadId'], THREAD)
    assert.equal(line['model'], 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(line['checkpointTokens'], 2_048)
    assert.equal(line['decision'], 'continue')
    assert.equal('reasoningText' in line, false)
  })

  it('no-ops without an active run context', async () => {
    recordReasoningCheckpoint(CHECKPOINT, 'mock-model')
    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.throws(() => readFileSync(join(root, PROJECT, 'reasoning-checkpoints.jsonl'), 'utf8'))
  })
})
