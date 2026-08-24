import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSpineEntries } from '@shared/threads/spine-schema.ts'
import { recordDecision, readDecisionLog, exportDecisionLog } from './decision-log-store.ts'

const PROJECT = 'proj-1'
const THREAD = 't-42'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function threadEventsPath(root: string, threadId = THREAD): string {
  return join(root, PROJECT, threadId, 'events.jsonl')
}

describe('decision-log-store', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-decision-log-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('records a decision onto the thread spine and reads it back', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'echo hi',
      scope: 'sandbox',
      remembered: true,
      threadId: THREAD,
      toolCallId: 'tc-1',
    })
    // Same per-project queue key → the read runs strictly after the append.
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, 1)
    const e = events[0]
    assert.ok(e)
    assert.equal(e.type, 'decision')
    assert.equal(e.kind, 'shell')
    assert.equal(e.actor, 'user')
    assert.equal(e.verdict, 'approved')
    assert.equal(e.subject, 'echo hi')
    assert.equal(e.scope, 'sandbox')
    assert.equal(e.remembered, true)
    assert.equal(e.threadId, THREAD)
    assert.equal(e.toolCallId, 'tc-1')
    assert.equal(typeof e.id, 'string')
    assert.equal(typeof e.at, 'number')
    assert.equal(existsSync(join(root, PROJECT, 'decisions.jsonl')), false)
    assert.equal(existsSync(threadEventsPath(root)), true)
  })

  it('writes a detail blob when detail is supplied', async () => {
    recordDecision({
      projectId: PROJECT,
      threadId: THREAD,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'shell command (arguments omitted)',
      detail: { originalCommand: 'echo safe', harmDecision: 'prompt' },
    })
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, 1)
    const id = events[0]?.id
    assert.ok(id)
    const raw = readFileSync(threadEventsPath(root), 'utf8')
    const line = parseSpineEntries(raw).map((e) => e.line)[0]
    assert.ok(line?.type === 'decision')
    assert.ok(line.detail)
    assert.equal(line.detail.ref, `blobs/decision-${id}.detail.json`)
    const detail: unknown = JSON.parse(
      readFileSync(join(root, PROJECT, THREAD, line.detail.ref), 'utf8'),
    )
    assert.deepEqual(detail, { originalCommand: 'echo safe', harmDecision: 'prompt' })
  })

  it('deletes a legacy project decisions.jsonl on read', async () => {
    recordDecision({
      projectId: PROJECT,
      threadId: THREAD,
      kind: 'mcp',
      actor: 'user',
      verdict: 'denied',
      subject: 'mcp__x__y',
    })
    await readDecisionLog(PROJECT)
    const legacy = join(root, PROJECT, 'decisions.jsonl')
    mkdirSync(join(root, PROJECT), { recursive: true })
    writeFileSync(legacy, '{"v":1,"type":"decision"}\n')
    assert.equal(existsSync(legacy), true)
    await readDecisionLog(PROJECT)
    assert.equal(existsSync(legacy), false)
  })

  it('redacts secrets before persisting', async () => {
    recordDecision({
      projectId: PROJECT,
      threadId: THREAD,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr view',
    })
    await readDecisionLog(PROJECT)
    const raw = readFileSync(threadEventsPath(root), 'utf8')
    assert.equal(raw.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), false)
    assert.equal(raw.includes('<redacted>'), true)
  })

  it('appends multiple decisions in order (append-only)', async () => {
    for (let i = 0; i < 5; i++) {
      recordDecision({
        projectId: PROJECT,
        threadId: THREAD,
        kind: 'shell',
        actor: 'user',
        verdict: 'approved',
        subject: `cmd-${String(i)}`,
      })
    }
    const events = await readDecisionLog(PROJECT)
    assert.deepEqual(
      events.map((e) => e.subject),
      ['cmd-0', 'cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'],
    )
  })

  it('returns an empty log for a project with no decisions', async () => {
    assert.deepEqual(await readDecisionLog('never-used'), [])
  })

  it('drops recordings without a project+thread (no _global bucket)', async () => {
    recordDecision({
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'orphan',
    })
    assert.deepEqual(await readDecisionLog(PROJECT), [])
  })

  it('exports a manifest + events bundle', async () => {
    recordDecision({
      projectId: PROJECT,
      threadId: THREAD,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'a',
    })
    recordDecision({
      projectId: PROJECT,
      threadId: THREAD,
      kind: 'web',
      actor: 'user',
      verdict: 'denied',
      subject: 'https://x.test',
    })
    const result = await exportDecisionLog(PROJECT)
    assert.equal(result.count, 2)
    assert.equal(existsSync(result.path), true)

    const lines = readFileSync(result.path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3) // manifest + 2 events
    assert.ok(lines[0])
    const manifest: unknown = JSON.parse(lines[0])
    assert.ok(isRecord(manifest))
    assert.equal(manifest['type'], 'decision-log-manifest')
    assert.equal(manifest['count'], 2)
    assert.equal(manifest['mediaType'], 'application/vnd.copse.decision-log+jsonl')
    const exportsDir = join(root, PROJECT, 'exports')
    assert.equal(readdirSync(exportsDir).length, 1)
  })

  it('does not throw when recording is impossible', () => {
    assert.doesNotThrow(() => {
      recordDecision({
        projectId: PROJECT,
        threadId: THREAD,
        kind: 'hook',
        actor: 'hook',
        verdict: 'blocked',
        subject: 'run_shell',
      })
    })
  })
})
