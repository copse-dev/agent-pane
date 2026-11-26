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
import { runWithThreadExecutionContext } from './thread-execution-context.ts'

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
    // JSON.parse returns `any`, which trips both #508 rules: asserting away
    // from it hits no-unsafe-type-assertion, and assigning it hits
    // no-unsafe-assignment. Widening to `unknown` is a safe assertion; the
    // object check then earns the typed spread. The suppressions baseline is
    // shrink-only, so this is fixed rather than added to it.
    const parsed = JSON.parse(raw) as unknown
    assert.ok(parsed !== null && typeof parsed === 'object', 'expected a JSON object')
    const line: Record<string, unknown> = { ...parsed }
    assert.equal(line['schemaVersion'], 1)
    assert.equal(line['threadId'], THREAD)
    assert.equal(line['model'], 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(line['checkpointTokens'], 2_048)
    assert.equal(line['decision'], 'continue')
    assert.equal('reasoningText' in line, false)
  })

  it('attributes a checkpoint to the thread and project that produced it while another runs', async () => {
    const OTHER_PROJECT = 'proj-reasoning-checkpoints-other'
    const OTHER_THREAD = 'thread-reasoning-checkpoints-other'
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
        recordReasoningCheckpoint({ ...CHECKPOINT, step: 1 }, 'model-first')
      })
      inThread(OTHER_PROJECT, OTHER_THREAD, () => {
        recordReasoningCheckpoint({ ...CHECKPOINT, step: 2 }, 'model-second')
        endHookRunRecording(OTHER_THREAD)
      })
      inThread(PROJECT, THREAD, () => {
        recordReasoningCheckpoint({ ...CHECKPOINT, step: 3 }, 'model-first')
      })
    } finally {
      endHookRunRecording(THREAD)
      endHookRunRecording(OTHER_THREAD)
    }

    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    await getThreadMeta(OTHER_PROJECT, OTHER_THREAD).catch(() => undefined)
    const read = (projectId: string): Record<string, unknown>[] =>
      readFileSync(join(root, projectId, 'reasoning-checkpoints.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((raw) => {
          const parsed = JSON.parse(raw) as unknown
          assert.ok(parsed !== null && typeof parsed === 'object', 'expected a JSON object')
          const line: Record<string, unknown> = { ...parsed }
          return line
        })
    const first = read(PROJECT)
    assert.deepEqual(
      first.map((line) => [line['threadId'], line['projectId'], line['step']]),
      [
        [THREAD, PROJECT, 1],
        [THREAD, PROJECT, 3],
      ],
    )
    assert.equal(first[0]?.['turnId'], first[1]?.['turnId'])
    assert.deepEqual(
      read(OTHER_PROJECT).map((line) => [line['threadId'], line['projectId'], line['step']]),
      [[OTHER_THREAD, OTHER_PROJECT, 2]],
    )
  })

  it('no-ops without an active run context', async () => {
    recordReasoningCheckpoint(CHECKPOINT, 'mock-model')
    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.throws(() => readFileSync(join(root, PROJECT, 'reasoning-checkpoints.jsonl'), 'utf8'))
  })
})
