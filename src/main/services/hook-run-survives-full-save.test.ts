// Contract tests for decision 6 of docs/plans/hooks-and-feature-packs.md:
// hook_run spine records are always-on and MUST round-trip through full thread
// saves. `writeThread` regenerates `events.jsonl` from `thread.messages` alone,
// so without the read-merge an independently appended hook_run line (and the
// blobs it references) silently vanish on the next save.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Thread } from '@shared/types'
import {
  SPINE_SCHEMA_VERSION,
  parseSpine,
  parseSpineEntries,
  toolsetBlobRef,
  type SpineHookRunLine,
} from '@shared/threads/spine-schema.ts'
import {
  appendHookRun,
  appendMessage,
  getThreadMeta,
  loadProjectThreads,
  saveProjectThread,
} from './thread-store.ts'
import {
  beginHookRunRecording,
  endHookRunRecording,
  recordCommandHookRun,
  recordFunctionHookRun,
  setHookRunStep,
  setHookRunToolset,
} from './hook-run-recorder.ts'
import { storageSet } from './storage/storage.ts'

const PROJECT = 'proj-hooks'
const THREAD = 't1'

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

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 10 }
}

function hookRunLine(id: string): SpineHookRunLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id,
    event: 'beforeShellExecution',
    hookId: './audit.sh',
    executor: 'command',
    turnId: 'turn-1',
    step: 1,
    startedAt: 100,
    durationMs: 25,
    exitCode: 0,
    parseOk: true,
    decision: { permission: 'allow' },
    stdout: { ref: `blobs/${id}.stdout.txt`, sha256: 'x' },
    stderr: { ref: `blobs/${id}.stderr.txt`, sha256: 'y' },
  }
}

/** Read the thread's raw spine and return its hook_run lines. */
function readHookRuns(root: string): SpineHookRunLine[] {
  const raw = readFileSync(join(root, PROJECT, THREAD, 'events.jsonl'), 'utf8')
  return parseSpineEntries(raw)
    .map((e) => e.line)
    .filter((l): l is SpineHookRunLine => l?.type === 'hook_run')
}

/** Flush the store's per-project write queue (recording appends are fire-and-forget). */
async function flushStore(): Promise<void> {
  await getThreadMeta(PROJECT, THREAD)
}

describe('hook_run survives full save (decision 6)', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-hook-run-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    endHookRunRecording(THREAD)
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('an appended hook_run line and its blobs survive a full thread save', async () => {
    const m1 = userMsg('m1', 'hello')
    await saveProjectThread(PROJECT, thread([m1]))
    await appendHookRun(PROJECT, THREAD, hookRunLine('h1'), [
      { ref: 'blobs/h1.stdout.txt', contents: 'OUT' },
      { ref: 'blobs/h1.stderr.txt', contents: 'ERR' },
    ])

    // Full save via the same writeThread path every whole-thread write uses.
    await saveProjectThread(PROJECT, thread([m1, userMsg('m2', 'again')]))

    const runs = readHookRuns(root)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.id, 'h1')
    // The blobs the line references survived stale-file pruning.
    const dir = join(root, PROJECT, THREAD)
    assert.equal(readFileSync(join(dir, 'blobs', 'h1.stdout.txt'), 'utf8'), 'OUT')
    assert.equal(readFileSync(join(dir, 'blobs', 'h1.stderr.txt'), 'utf8'), 'ERR')
    // And the message spine still folds cleanly for old readers.
    const loaded = await loadProjectThreads(PROJECT)
    assert.deepEqual(
      loaded[0]?.messages.map((m) => m.id),
      ['m1', 'm2'],
    )
  })

  it('a hook_run line stays anchored after its emitting message across rewrites', async () => {
    const m1 = userMsg('m1', 'one')
    const m2 = userMsg('m2', 'two')
    await saveProjectThread(PROJECT, thread([m1]))
    await appendHookRun(PROJECT, THREAD, hookRunLine('h1'))
    await saveProjectThread(PROJECT, thread([m1, m2]))

    const raw = readFileSync(join(root, PROJECT, THREAD, 'events.jsonl'), 'utf8')
    assert.deepEqual(
      parseSpineEntries(raw).map((e) => e.line?.id),
      ['m1', 'h1', 'm2'],
    )
  })

  it('appendMessage preserves previously appended hook_run lines', async () => {
    const m1 = userMsg('m1', 'one')
    await saveProjectThread(PROJECT, thread([m1]))
    await appendHookRun(PROJECT, THREAD, hookRunLine('h1'))
    await appendMessage(PROJECT, THREAD, userMsg('m2', 'two'))

    const raw = readFileSync(join(root, PROJECT, THREAD, 'events.jsonl'), 'utf8')
    assert.deepEqual(
      parseSpineEntries(raw).map((e) => e.line?.id),
      ['m1', 'h1', 'm2'],
    )
    // Old readers still see messages only.
    assert.deepEqual(
      parseSpine(raw).map((m) => m.id),
      ['m1', 'm2'],
    )
  })

  it('records command and function hook runs with attribution and toolset blob', async () => {
    storageSet('activeProjectId', PROJECT)
    await saveProjectThread(PROJECT, thread([userMsg('m1', 'go')]))

    beginHookRunRecording(THREAD)
    setHookRunToolset([{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }])
    setHookRunStep(3)
    recordCommandHookRun({
      event: 'beforeShellExecution',
      hookId: './audit.sh',
      startedAt: 100,
      durationMs: 12,
      exitCode: 0,
      parseOk: false,
      decision: {},
      stdout: 'debug print, not json',
      stderr: 'warning: something',
    })
    recordFunctionHookRun({
      event: 'turnStart',
      hookId: 'todo-steering',
      startedAt: 100,
      durationMs: 1,
      outcome: { injectContext: 'steering block' },
    })
    endHookRunRecording(THREAD)
    await flushStore()

    const runs = readHookRuns(root)
    assert.equal(runs.length, 2)

    const command = runs.find((r) => r.executor === 'command')
    assert.ok(command)
    assert.equal(command.event, 'beforeShellExecution')
    assert.equal(command.hookId, './audit.sh')
    assert.equal(command.step, 3)
    assert.equal(command.exitCode, 0)
    assert.equal(command.parseOk, false)
    assert.ok(command.turnId)
    assert.ok(command.toolset)
    const dir = join(root, PROJECT, THREAD)
    assert.ok(command.stdout && command.stderr)
    assert.equal(readFileSync(join(dir, command.stdout.ref), 'utf8'), 'debug print, not json')
    assert.equal(readFileSync(join(dir, command.stderr.ref), 'utf8'), 'warning: something')
    // The toolset fingerprint blob is content-addressed next to the streams.
    assert.ok(existsSync(join(dir, toolsetBlobRef(command.toolset))))

    const fn = runs.find((r) => r.executor === 'function')
    assert.ok(fn)
    assert.equal(fn.event, 'turnStart')
    assert.equal(fn.hookId, 'todo-steering')
    // Function hooks: no process, so no exit code and no stream blobs.
    assert.equal(fn.exitCode, undefined)
    assert.equal(fn.stdout, undefined)
    assert.equal(fn.parseOk, true)
    assert.equal(fn.decision.injectContextChars, 'steering block'.length)
    // Both executions share the run's turn attribution.
    assert.equal(fn.turnId, command.turnId)
  })

  it('records nothing when no run context is active', async () => {
    await saveProjectThread(PROJECT, thread([userMsg('m1', 'go')]))
    recordFunctionHookRun({
      event: 'turnStart',
      hookId: 'todo-steering',
      startedAt: 1,
      durationMs: 1,
      outcome: null,
    })
    await flushStore()
    assert.equal(readHookRuns(root).length, 0)
  })
})
