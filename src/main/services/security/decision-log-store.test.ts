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
import {
  parseSpineEntries,
  SPINE_SCHEMA_VERSION,
  type SpinePermissionDecisionLine,
} from '@shared/threads/spine-schema.ts'
import {
  recordDecision,
  readDecisionLog,
  readThreadDecisionLog,
  exportDecisionLog,
  runWithDecisionRecorder,
  type RecordedDecision,
} from './decision-log-store.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'

const PROJECT = 'proj-1'
const THREAD = 't-42'

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

  it('isolates asynchronous host audit records and resumes desktop persistence outside the scope', async () => {
    const outer: RecordedDecision[] = []
    const inner: RecordedDecision[] = []
    const other: RecordedDecision[] = []
    const record = (subject: string): void => {
      recordDecision({
        projectId: PROJECT,
        threadId: THREAD,
        kind: 'shell',
        actor: 'user',
        verdict: 'approved',
        subject,
        toolCallId: subject,
        detail: { toolCallIds: [subject] },
      })
    }
    await Promise.all([
      runWithDecisionRecorder(
        (decision) => outer.push(decision),
        async () => {
          record('outer-first')
          await Promise.resolve()
          runWithDecisionRecorder(
            (decision) => inner.push(decision),
            () => {
              record('inner')
            },
          )
          record('outer-last')
        },
      ),
      runWithDecisionRecorder(
        (decision) => other.push(decision),
        async () => {
          await Promise.resolve()
          record('other')
        },
      ),
    ])
    assert.deepEqual(
      outer.map((decision) => decision.line.subject),
      ['outer-first', 'outer-last'],
    )
    assert.deepEqual(
      inner.map((decision) => decision.line.subject),
      ['inner'],
    )
    assert.deepEqual(
      other.map((decision) => decision.line.subject),
      ['other'],
    )
    assert.equal(existsSync(threadEventsPath(root)), false)
    const nested = inner[0]
    assert.ok(nested)
    assert.equal(nested.line.toolCallId, 'inner')
    assert.equal(nested.detailContents, JSON.stringify({ toolCallIds: ['inner'] }))
    record('desktop')
    assert.deepEqual(
      (await readDecisionLog(PROJECT)).map((event) => event.subject),
      ['desktop'],
    )
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

  it('reads legacy permission_decision lines in a single-thread read', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'echo hi',
      scope: 'sandbox',
      threadId: THREAD,
    })
    await readDecisionLog(PROJECT)
    const legacy: SpinePermissionDecisionLine = {
      v: SPINE_SCHEMA_VERSION,
      type: 'permission_decision',
      id: 'legacy-1',
      decidedAt: Date.now() + 1000,
      originalCommand: 'rm -rf build',
      originalMode: 'guarded-yolo',
      effectiveMode: 'guarded-yolo',
      sandboxState: 'unsandboxed',
      harmDecision: 'prompt',
      policyDecision: 'prompt',
      reasons: ['recursive delete'],
      userResponse: 'declined',
    }
    const path = threadEventsPath(root)
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(legacy)}\n`)

    const events = await readThreadDecisionLog(PROJECT, THREAD)
    assert.equal(events.length, 2)
    const migrated = events[1]
    assert.ok(migrated)
    assert.equal(migrated.id, 'legacy-1')
    assert.equal(migrated.verdict, 'denied')
    assert.equal(migrated.scope, 'external')
    assert.equal(migrated.threadId, THREAD)
    assert.equal(migrated.subject, 'shell command (arguments omitted)')
    assert.deepEqual(await readDecisionLog(PROJECT), events)
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

  it("attributes concurrent turns in two projects to each turn's own project", async () => {
    const previous = storageGet('activeProjectId')
    // The window shows a third project; no turn below belongs to it.
    storageSet('activeProjectId', 'window-project')
    const turn = (projectId: string, threadId: string): Promise<void> =>
      threadExecutionContextStorage.run(
        {
          projectId,
          threadId,
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity(threadId, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            recordDecision({
              kind: 'shell',
              actor: 'user',
              verdict: 'approved',
              subject: projectId,
            })
            // A thread named outside its own turn has no project to borrow.
            recordDecision({
              kind: 'shell',
              actor: 'user',
              verdict: 'approved',
              subject: 'foreign',
              threadId: 'foreign-thread',
            })
          }),
      )
    try {
      await Promise.all([turn('project-a', 'thread-a'), turn('project-b', 'thread-b')])
    } finally {
      storageSet('activeProjectId', previous)
    }
    for (const { projectId, threadId } of [
      { projectId: 'project-a', threadId: 'thread-a' },
      { projectId: 'project-b', threadId: 'thread-b' },
    ]) {
      const events = await readDecisionLog(projectId)
      assert.deepEqual(
        events.map((event) => [event.threadId, event.subject]),
        [[threadId, projectId]],
      )
    }
    assert.deepEqual(await readDecisionLog('window-project'), [])
  })

  it("records an isolated worker's unattributed decision on its run's thread and project", async () => {
    const previous = storageGet('activeProjectId')
    storageSet('activeProjectId', 'window-project')
    try {
      // The parent run's identity stays on the dispatching thread while the
      // worker executes its own turn (isolated-worker-checkout.ts), in the
      // parent's project.
      await runWithActiveRunIdentity('parent-thread', () =>
        threadExecutionContextStorage.run(
          {
            projectId: 'project-a',
            threadId: 'worker-thread',
            projectRoot: root,
            root,
            checkoutMode: 'worktree',
            branch: null,
          },
          async () => {
            recordDecision({
              kind: 'hook',
              actor: 'hook',
              verdict: 'blocked',
              subject: 'run_shell',
            })
          },
        ),
      )
    } finally {
      storageSet('activeProjectId', previous)
    }
    const events = await readDecisionLog('project-a')
    assert.deepEqual(
      events.map((event) => [event.threadId, event.subject]),
      [['parent-thread', 'run_shell']],
    )
    assert.deepEqual(await readDecisionLog('window-project'), [])
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
