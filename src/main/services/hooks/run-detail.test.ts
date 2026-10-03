// Contract tests for the hook-card inspector's read path (`hooks:run-detail`).
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

describe('hooks:run-detail — the raw record behind a hook card', () => {
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

  it('captures own proto fields and native toJSON key and self-return semantics', async () => {
    let calls = 0
    const selfReturning = {
      label: 'self',
      toJSON(): unknown {
        calls++
        return this
      },
    }
    const payload = {
      nested: {
        toJSON(key: string): unknown {
          return { suppliedKey: key }
        },
      },
      selfReturning,
    }
    Object.defineProperty(payload, '__proto__', { value: { preserved: true }, enumerable: true })
    recordFunctionHookRun({
      event: 'beforeFinalize',
      hookId: 'json-semantics',
      startedAt: 100,
      durationMs: 1,
      payload,
      outcome: { injectContext: 'context' },
    })
    await flushStore()
    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.ok(detail.payload)
    assert.ok(detail.payload.includes('"__proto__"'))
    assert.ok(detail.payload.includes('"preserved": true'))
    assert.ok(detail.payload.includes('"suppliedKey": "nested"'))
    assert.ok(detail.payload.includes('"label": "self"'))
    assert.equal(calls, 1)
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

  it('keeps the decision inputs of a truncated payload, not just the transcript prefix', async () => {
    // The stepBoundary payload nests the transcript ahead of the numbers the
    // guards decide on. A real run's transcript outgrows the capture bound, so
    // field order alone decided whether the inputs survived — they never did.
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${String(i)} `.repeat(120),
    }))
    recordFunctionHookRun({
      event: 'stepBoundary',
      hookId: 'loop-nudge',
      startedAt: 100,
      durationMs: 1,
      outcome: { injectContext: 'stop gathering context' },
      payload: {
        phase: 'preStream',
        escalation: {
          input: {
            messages,
            maxContextTokens: 128_000,
            toolSchemaReserveTokens: 4_000,
            toolOnlySteps: 7,
            trimEvents: 2,
          },
          pressure: {
            conversationBudget: 120_000,
            conversationTokens: 109_200,
            fillRatio: 0.91,
            thresholds: { softNudgeMinToolSteps: 30, forceTextMinToolSteps: 48 },
          },
        },
        loopNudgeSent: false,
        forceTextAttempted: false,
        streamCappedAsRunaway: false,
        consecutiveExploreWithoutRead: 1,
      },
    })
    await flushStore()

    const payload = (await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))).payload ?? ''
    assert.ok(JSON.stringify(messages).length > 32_000, 'fixture must outgrow the capture bound')
    assert.match(payload, /truncated \d+ more chars/)
    for (const field of [
      /"phase": "preStream"/,
      /"loopNudgeSent": false/,
      /"forceTextAttempted": false/,
      /"consecutiveExploreWithoutRead": 1/,
      /"maxContextTokens": 128000/,
      /"toolSchemaReserveTokens": 4000/,
      /"toolOnlySteps": 7/,
      /"trimEvents": 2/,
      /"conversationBudget": 120000/,
      /"conversationTokens": 109200/,
      /"fillRatio": 0.91/,
      /"softNudgeMinToolSteps": 30/,
      /"forceTextMinToolSteps": 48/,
    ]) {
      assert.match(payload, field)
    }
    // Order is presentation only: the arrays inside keep theirs.
    assert.ok(payload.indexOf('turn 0 ') < payload.indexOf('turn 1 '))
  })

  it('drops only the payload blob when the payload cannot be serialized', async () => {
    const cyclic: Record<string, unknown> = { prompt: 'loop' }
    cyclic['self'] = cyclic
    recordFunctionHookRun({
      event: 'beforeSubmitPrompt',
      hookId: 'cyclic-hook',
      startedAt: 100,
      durationMs: 1,
      outcome: { injectContext: 'still recorded' },
      payload: cyclic,
    })
    await flushStore()

    const detail = await readHookRunDetail(PROJECT, THREAD, recordedRunId(root))
    assert.equal(detail.payload, undefined)
    assert.match(detail.outcome ?? '', /still recorded/)
  })
})
