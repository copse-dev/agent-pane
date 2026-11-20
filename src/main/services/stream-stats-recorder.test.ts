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
import { expectRecord } from '@shared/unknown-value.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'

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
    const line = expectRecord(JSON.parse(raw) as unknown)
    assert.equal(line['schemaVersion'], 1)
    assert.equal(line['threadId'], THREAD)
    assert.equal(line['model'], 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(line['cutReason'], 'reasoning_runaway_cap')
    assert.equal(line['reasoningText'], sampleCut().reasoningText)
    assert.equal(line['willInjectReasoningRunawayNudge'], true)
    assert.equal(line['totalTokensEstimate'], 32_000)
    assert.equal(line['reasoningTokensEstimate'], 30_000)
  })

  it('attributes a cut to the thread and project that produced it while another runs', async () => {
    const OTHER_PROJECT = 'proj-stream-stats-other'
    const OTHER_THREAD = 'thread-stream-stats-other'
    const inThread = <T>(projectId: string, threadId: string, fn: () => T): T =>
      runWithThreadExecutionContext(
        { projectId, threadId, projectRoot: root, root, checkoutMode: 'shared', branch: null },
        fn,
      )
    try {
      inThread(PROJECT, THREAD, () => {
        beginHookRunRecording(THREAD)
      })
      // A second turn starts in another project; the active project stays PROJECT.
      inThread(OTHER_PROJECT, OTHER_THREAD, () => {
        beginHookRunRecording(OTHER_THREAD)
      })
      inThread(PROJECT, THREAD, () => {
        recordStreamCut(sampleCut({ step: 1 }), 'model-first')
      })
      inThread(OTHER_PROJECT, OTHER_THREAD, () => {
        recordStreamCut(sampleCut({ step: 2 }), 'model-second')
        endHookRunRecording(OTHER_THREAD)
      })
      inThread(PROJECT, THREAD, () => {
        recordStreamCut(sampleCut({ step: 3 }), 'model-first')
      })
    } finally {
      endHookRunRecording(THREAD)
      endHookRunRecording(OTHER_THREAD)
    }

    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    await getThreadMeta(OTHER_PROJECT, OTHER_THREAD).catch(() => undefined)
    const read = (projectId: string): Record<string, unknown>[] =>
      readFileSync(join(root, projectId, 'stream-stats.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((raw) => expectRecord(JSON.parse(raw) as unknown))
    const first = read(PROJECT)
    assert.deepEqual(
      first.map((line) => [line['threadId'], line['projectId'], line['step']]),
      [
        [THREAD, PROJECT, 1],
        [THREAD, PROJECT, 3],
      ],
    )
    assert.equal(first[0]?.['turnId'], first[1]?.['turnId'])
    const second = read(OTHER_PROJECT)
    assert.deepEqual(
      second.map((line) => [line['threadId'], line['projectId'], line['step']]),
      [[OTHER_THREAD, OTHER_PROJECT, 2]],
    )
    assert.notEqual(second[0]?.['turnId'], first[0]?.['turnId'])
  })

  it('no-ops when no hook-run recording context is active', async () => {
    recordStreamCut(sampleCut(), 'mock-model')
    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    const statsPath = join(root, PROJECT, 'stream-stats.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.throws(() => readFileSync(statsPath, 'utf8'))
  })
})
