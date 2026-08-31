import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppliedNudgeRecord } from '@copse/agent/run-agent-loop.ts'
import { parseSpineLine } from '@shared/threads/spine-schema.ts'
import { beginHookRunRecording, endHookRunRecording } from './hook-run-recorder.ts'
import { recordAppliedNudge } from './nudge-recorder.ts'
import { storageSet } from './storage/storage.ts'
import { getThreadMeta } from './thread-store.ts'

const PROJECT = 'proj-nudge-recorder'
const THREAD = 'thread-nudge-recorder'
const RECORD: AppliedNudgeRecord = {
  step: 4,
  hookId: 'final-answer-nudge',
  mechanism: 'text-only-turn',
  cause: 'step-budget-exhausted',
  text: 'Based on your exploration so far, write a clear final answer for the user.',
}

describe('nudge-recorder', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-nudge-recorder-'))
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

  it('appends the exact model-visible nudge to the thread spine', async () => {
    beginHookRunRecording(THREAD)
    recordAppliedNudge(RECORD)
    endHookRunRecording(THREAD)

    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    const raw = readFileSync(join(root, PROJECT, THREAD, 'events.jsonl'), 'utf8').trim()
    const line = parseSpineLine(raw)
    assert.equal(line?.type, 'nudge')
    assert.equal(line.turnId?.length, 36)
    assert.equal(line.step, 4)
    assert.equal(line.hookId, RECORD.hookId)
    assert.equal(line.mechanism, RECORD.mechanism)
    assert.equal(line.cause, RECORD.cause)
    assert.equal(line.text, RECORD.text)
  })

  it('does nothing without an active run context', async () => {
    recordAppliedNudge(RECORD)
    await getThreadMeta(PROJECT, THREAD).catch(() => undefined)
    assert.equal(existsSync(join(root, PROJECT, THREAD, 'events.jsonl')), false)
  })
})
