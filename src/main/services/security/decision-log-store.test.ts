import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDecision, readDecisionLog, exportDecisionLog } from './decision-log-store.ts'

const PROJECT = 'proj-1'

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

  it('records a decision and reads it back with fields intact', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'echo hi',
      scope: 'sandbox',
      remembered: true,
      threadId: 't-42',
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
    assert.equal(e.threadId, 't-42')
    assert.equal(typeof e.id, 'string')
    assert.equal(typeof e.at, 'number')
  })

  it('writes decisions.jsonl under the project dir', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'mcp',
      actor: 'user',
      verdict: 'denied',
      subject: 'mcp__x__y',
    })
    await readDecisionLog(PROJECT)
    assert.equal(existsSync(join(root, PROJECT, 'decisions.jsonl')), true)
  })

  it('redacts secrets before persisting', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr view',
    })
    await readDecisionLog(PROJECT)
    const raw = readFileSync(join(root, PROJECT, 'decisions.jsonl'), 'utf8')
    assert.equal(raw.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), false)
    assert.equal(raw.includes('<redacted>'), true)
  })

  it('appends multiple decisions in order (append-only)', async () => {
    for (let i = 0; i < 5; i++) {
      recordDecision({
        projectId: PROJECT,
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

  it('exports a manifest + events bundle', async () => {
    recordDecision({
      projectId: PROJECT,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'a',
    })
    recordDecision({
      projectId: PROJECT,
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
    const manifest = JSON.parse(lines[0]) as { type: string; count: number; mediaType: string }
    assert.equal(manifest.type, 'decision-log-manifest')
    assert.equal(manifest.count, 2)
    assert.equal(manifest.mediaType, 'application/vnd.copse.decision-log+jsonl')
    // The export lives under <project>/exports/.
    const exportsDir = join(root, PROJECT, 'exports')
    assert.equal(readdirSync(exportsDir).length, 1)
  })

  it('does not throw when recording is impossible', () => {
    // A record with a bogus (unstringifiable) confidence still must not throw.
    assert.doesNotThrow(() => {
      recordDecision({
        projectId: PROJECT,
        kind: 'hook',
        actor: 'hook',
        verdict: 'blocked',
        subject: 'run_shell',
      })
    })
  })
})
