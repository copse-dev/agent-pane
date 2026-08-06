// Contract tests for the hook-card inspector's read path (`hooks:runDetail`).
//
// Decision 6 says every hook execution is recorded; decision 10 renders that as
// a compact card. The gap this closes is *between* them: a card that says
// "Added context" has to be openable to show which context. That only works if
// the recorder captures the bodies and this reader hands them back — so these
// tests drive the real recorder into a real thread store and read them out
// again, rather than asserting either half in isolation.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Thread } from '@shared/types'
import { getThreadMeta, saveProjectThread } from '../thread-store.ts'
import {
  beginHookRunRecording,
  endHookRunRecording,
  recordCommandHookRun,
  recordFunctionHookRun,
  setHookRunStep,
} from '../hook-run-recorder.ts'
import { storageSet } from '../storage/storage.ts'
import { readHookRunDetail } from './run-detail.ts'
import { parseSpineEntries } from '@shared/threads/spine-schema.ts'
import { readFileSync } from 'node:fs'

const PROJECT = 'proj-run-detail'
const THREAD = 't-detail'

function thread(messages: Message[]): Thread {
  return {
    id: THREAD,
    title: THREAD,
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Flush the store's per-project write queue (recording appends are fire-and-forget). */
async function flushStore(): Promise<void> {
  await getThreadMeta(PROJECT, THREAD)
}

/** The id of the single hook_run line the test just recorded. */
function recordedRunId(root: string): string {
  const raw = readFileSync(join(root, PROJECT, THREAD, 'events.jsonl'), 'utf8')
  const ids = parseSpineEntries(raw)
    .map((entry) => entry.line)
    .filter((line) => line?.type === 'hook_run')
    .map((line) => line.id)
  assert.equal(ids.length, 1, 'expected exactly one recorded hook run')
  const id = ids[0]
  assert.ok(id)
  return id
}

describe('hooks:runDetail — the raw record behind a hook card', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-run-detail-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('activeProjectId', PROJECT)
    await saveProjectThread(
      PROJECT,
      thread([{ id: 'm1', role: 'user', content: 'go', toolCalls: [], createdAt: 10 }]),
    )
    beginHookRunRecording(THREAD)
  })

  afterEach(() => {
    endHookRunRecording(THREAD)
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the context a function hook injected, not just its length', async () => {
    setHookRunStep(2)
    recordFunctionHookRun({
      event: 'beforeFinalize',
      hookId: 'todo-finalize-closeout',
      startedAt: 100,
      durationMs: 3,
      payload: { openTodos: [{ content: 'ship it', status: 'pending' }], attempt: 0 },
      outcome: { injectContext: 'You still have open todos.' },
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.equal(detail.found, true)
    assert.equal(detail.hookId, 'todo-finalize-closeout')
    assert.equal(detail.executor, 'function')
    assert.equal(detail.step, 2)
    assert.match(detail.outcome ?? '', /You still have open todos\./)
    // The payload answers the other half: why it fired at all.
    assert.match(detail.payload ?? '', /"attempt": 0/)
    assert.match(detail.payload ?? '', /ship it/)
  })

  it('captures the payload of a function hook that threw, so the error has context', async () => {
    recordFunctionHookRun({
      event: 'turnStart',
      hookId: 'exploding-hook',
      startedAt: 100,
      durationMs: 1,
      payload: { prompt: 'do the thing' },
      outcome: null,
      error: 'boom',
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.match(detail.payload ?? '', /do the thing/)
    assert.equal(detail.outcome, undefined)
  })

  it('captures nothing for a hook that abstained — there is no answer to show', async () => {
    recordFunctionHookRun({
      event: 'turnStart',
      hookId: 'quiet-hook',
      startedAt: 100,
      durationMs: 1,
      payload: { prompt: 'do the thing' },
      outcome: null,
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.equal(detail.found, true)
    assert.equal(detail.payload, undefined)
    assert.equal(detail.outcome, undefined)
  })

  it('returns the whole exchange for a command hook — stdin, stdout, stderr', async () => {
    recordCommandHookRun({
      event: 'beforeShellExecution',
      hookId: './audit.sh',
      startedAt: 100,
      durationMs: 12,
      exitCode: 0,
      parseOk: true,
      decision: { permission: 'deny' },
      stdin: '{"command":"rm -rf /"}',
      stdout: '{"permission":"deny"}',
      stderr: 'refusing destructive command\n',
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.equal(detail.executor, 'command')
    assert.equal(detail.payload, '{"command":"rm -rf /"}')
    assert.equal(detail.stdout, '{"permission":"deny"}')
    assert.match(detail.stderr ?? '', /refusing destructive command/)
    assert.equal(detail.exitCode, 0)
  })

  it('reports an unrecorded run rather than failing the inspector open', async () => {
    const detail = await readHookRunDetail(PROJECT, THREAD, 'no-such-run')
    assert.deepEqual(detail, { found: false })
  })

  it('bounds an outsized capture with a visible truncation marker', async () => {
    recordFunctionHookRun({
      event: 'turnStart',
      hookId: 'chatty-hook',
      startedAt: 100,
      durationMs: 1,
      outcome: { injectContext: 'x'.repeat(80_000) },
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.ok((detail.outcome?.length ?? 0) < 80_000)
    assert.match(detail.outcome ?? '', /truncated \d+ more chars/)
  })
})
