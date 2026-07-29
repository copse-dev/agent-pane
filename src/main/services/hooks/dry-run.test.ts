// G2 (docs/plans/hooks-and-feature-packs.md): the dry-run hook tester. Pins
// synthetic payload synthesis per event, the wire→canonical dry-run plan
// mapping, the end-to-end spawn (stdin/stdout/stderr/exit/duration + parse_ok +
// outcome summary), and — critically — that a dry run is SIDE-EFFECT-FREE: it
// never records a Sources per-hook runtime failure (it must not mutate the
// state a real run would).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  dryRunHook,
  dryRunPlanFor,
  synthesizeCanonicalPayload,
  summarizeInterpretation,
} from './dry-run.ts'
import type { HookTestRequest } from '@shared/types/hooks.ts'
import { listCursorHooks, resetCursorHookSessionErrorsForTest } from './cursor-adapter.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetCursorHookSessionErrorsForTest()
})

/** Write a `.cursor/hooks.json` with one beforeShellExecution hook; return its config path. */
function seedCursorHook(command: string): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'copse-dry-run-'))
  tmpDirs.push(root)
  mkdirSync(join(root, '.cursor'), { recursive: true })
  const source = join(root, '.cursor', 'hooks.json')
  writeFileSync(
    source,
    JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command }] } }),
    'utf8',
  )
  return { root, source }
}

describe('dry-run — synthesizeCanonicalPayload', () => {
  it('builds a shell toolGate payload with a synthetic command', () => {
    const p = synthesizeCanonicalPayload({ canonicalEvent: 'toolGate', toolName: 'run_shell' })
    assert.ok(p)
    assert.equal(p['toolName'], 'run_shell')
    assert.deepEqual(p['input'], { command: 'echo "copse hook dry-run"' })
  })

  it('builds an MCP toolGate payload for an mcp__ tool', () => {
    const p = synthesizeCanonicalPayload({
      canonicalEvent: 'toolGate',
      toolName: 'mcp__example__run',
    })
    assert.ok(p)
    assert.equal(p['toolName'], 'mcp__example__run')
    assert.deepEqual(p['input'], { example: 'value' })
  })

  it('builds a read_file toolGate payload carrying synthetic file content', () => {
    const p = synthesizeCanonicalPayload({ canonicalEvent: 'toolGate', toolName: 'read_file' })
    assert.ok(p)
    assert.equal(p['toolName'], 'read_file')
    assert.equal(typeof p['fileContent'], 'string')
  })

  it('builds an afterToolUse observation payload', () => {
    const p = synthesizeCanonicalPayload({ canonicalEvent: 'afterToolUse', toolName: 'run_shell' })
    assert.ok(p)
    assert.equal(p['toolName'], 'run_shell')
    assert.equal(p['isError'], false)
    assert.equal(typeof p['output'], 'string')
  })

  it('builds minimal payloads for the notification / lifecycle events', () => {
    assert.deepEqual(synthesizeCanonicalPayload({ canonicalEvent: 'stop' }), {
      status: 'completed',
    })
    assert.deepEqual(synthesizeCanonicalPayload({ canonicalEvent: 'sessionStart' }), {
      firstTurn: true,
    })
    assert.deepEqual(synthesizeCanonicalPayload({ canonicalEvent: 'subagentStop' }), {
      subagentType: 'explore',
      status: 'completed',
    })
    const afterDiff = synthesizeCanonicalPayload({ canonicalEvent: 'afterDiffApply' })
    assert.ok(afterDiff)
    assert.equal(afterDiff['applied'], true)
    const perm = synthesizeCanonicalPayload({ canonicalEvent: 'permissionDecision' })
    assert.ok(perm)
    assert.equal(perm['decision'], 'allow')
  })

  it('returns null for events with no dry-runnable payload', () => {
    assert.equal(synthesizeCanonicalPayload({ canonicalEvent: 'turnStart' }), null)
    assert.equal(synthesizeCanonicalPayload({ canonicalEvent: 'beforeFinalize' }), null)
    assert.equal(synthesizeCanonicalPayload({ canonicalEvent: 'stepBoundary' }), null)
    assert.equal(synthesizeCanonicalPayload({ canonicalEvent: 'compaction' }), null)
  })
})

describe('dry-run — dryRunPlanFor', () => {
  it('maps Cursor tool-gate wire events onto toolGate flavors', () => {
    assert.deepEqual(dryRunPlanFor('cursor', 'beforeShellExecution'), {
      canonicalEvent: 'toolGate',
      toolName: 'run_shell',
    })
    assert.deepEqual(dryRunPlanFor('cursor', 'beforeMCPExecution'), {
      canonicalEvent: 'toolGate',
      toolName: 'mcp__example__run',
    })
    assert.deepEqual(dryRunPlanFor('cursor', 'beforeReadFile'), {
      canonicalEvent: 'toolGate',
      toolName: 'read_file',
    })
    assert.deepEqual(dryRunPlanFor('cursor', 'afterShellExecution'), {
      canonicalEvent: 'afterToolUse',
      toolName: 'run_shell',
    })
    assert.deepEqual(dryRunPlanFor('cursor', 'postToolUse'), {
      canonicalEvent: 'afterToolUse',
      toolName: 'run_shell',
      isError: false,
    })
    assert.deepEqual(dryRunPlanFor('cursor', 'postToolUseFailure'), {
      canonicalEvent: 'afterToolUse',
      toolName: 'run_shell',
      isError: true,
    })
  })

  it('maps Cursor 1:1 events and rejects unknown ones', () => {
    assert.deepEqual(dryRunPlanFor('cursor', 'stop'), { canonicalEvent: 'stop' })
    assert.equal(dryRunPlanFor('cursor', 'notARealEvent'), null)
  })

  it('maps Claude wire events', () => {
    assert.deepEqual(dryRunPlanFor('claude', 'PreToolUse'), {
      canonicalEvent: 'toolGate',
      toolName: 'run_shell',
    })
    assert.deepEqual(dryRunPlanFor('claude', 'SessionStart'), { canonicalEvent: 'sessionStart' })
    assert.equal(dryRunPlanFor('claude', 'afterFileEdit'), null)
  })

  it('maps Copse canonical event names directly', () => {
    assert.deepEqual(dryRunPlanFor('copse', 'toolGate'), {
      canonicalEvent: 'toolGate',
      toolName: 'run_shell',
    })
    assert.deepEqual(dryRunPlanFor('copse', 'beforeDiffApply'), {
      canonicalEvent: 'beforeDiffApply',
    })
    assert.equal(dryRunPlanFor('copse', 'not-an-event'), null)
  })
})

describe('dry-run — summarizeInterpretation', () => {
  it('summarizes a clean decision', () => {
    assert.equal(
      summarizeInterpretation({
        outcome: { decision: 'deny', agentMessage: 'blocked' },
        failed: false,
        parseOk: true,
        spineEvent: 'beforeShellExecution',
        spineDecision: {},
      }),
      'deny; agent: blocked',
    )
  })

  it('summarizes an abstention and a failure', () => {
    assert.equal(
      summarizeInterpretation({
        outcome: null,
        failed: false,
        parseOk: true,
        spineEvent: 'stop',
        spineDecision: {},
      }),
      'no opinion',
    )
    assert.equal(
      summarizeInterpretation({
        outcome: null,
        failed: true,
        parseOk: false,
        spineEvent: 'beforeShellExecution',
        spineDecision: {},
        runtimeError: 'timed out after 30s',
      }),
      'failed — timed out after 30s',
    )
  })
})

describe('dry-run — dryRunHook end-to-end', () => {
  it('spawns the hook and captures stdin/stdout/exit/duration', async () => {
    // `cat` echoes the marshalled stdin back on stdout — so the captured stdout
    // must parse to the synthetic tool-gate payload we fed the hook.
    const { source } = seedCursorHook('cat')
    const req: HookTestRequest = {
      family: 'cursor',
      event: 'beforeShellExecution',
      command: 'cat',
      source,
      scope: 'project',
    }
    const res = await dryRunHook(req)
    assert.equal(res.ran, true)
    assert.equal(res.canonicalEvent, 'toolGate')
    assert.equal(res.wireEvent, 'beforeShellExecution')
    assert.equal(res.exitCode, 0)
    assert.equal(res.parseOk, true)
    assert.equal(typeof res.durationMs, 'number')
    assert.ok((res.durationMs ?? -1) >= 0)
    // stdin is the pretty-printed marshalled payload; stdout is what cat echoed.
    assert.ok(res.stdin && res.stdin.includes('copse hook dry-run'))
    assert.ok(res.stdin.includes('conversation_id'))
    const echoed = expectRecord(parseJsonUnknown(res.stdout ?? '{}'))
    assert.equal(echoed['command'], 'echo "copse hook dry-run"')
    // The echoed request is not a valid hook *response*, so no decision applies.
    assert.equal(res.outcomeSummary, 'no opinion')
  })

  it('surfaces a hook decision as the outcome summary', async () => {
    const { source } = seedCursorHook(
      `printf '%s' '{"permission":"deny","agentMessage":"blocked by dry-run"}'`,
    )
    const res = await dryRunHook({
      family: 'cursor',
      event: 'beforeShellExecution',
      command: `printf '%s' '{"permission":"deny","agentMessage":"blocked by dry-run"}'`,
      source,
      scope: 'project',
    })
    assert.equal(res.ran, true)
    assert.equal(res.parseOk, true)
    assert.match(res.outcomeSummary ?? '', /deny/)
    assert.match(res.outcomeSummary ?? '', /blocked by dry-run/)
  })

  it('reports an unsupported event without spawning anything', async () => {
    const res = await dryRunHook({
      family: 'cursor',
      event: 'notARealEvent',
      command: 'echo hi',
      source: '/tmp/.cursor/hooks.json',
      scope: 'user',
    })
    assert.equal(res.ran, false)
    assert.match(res.error ?? '', /unsupported/)
    assert.equal(res.stdout, undefined)
  })

  it('does NOT record a Sources per-hook runtime failure (side-effect-free)', async () => {
    // A failing dry run must not populate the per-hook `lastError` a real run
    // would — proving `dryRunHook` never calls the adapter's recordRuntimeFailure.
    resetCursorHookSessionErrorsForTest()
    const command = 'exit 3'
    const { root, source } = seedCursorHook(command)
    const res = await dryRunHook({
      family: 'cursor',
      event: 'beforeShellExecution',
      command,
      source,
      scope: 'project',
    })
    assert.equal(res.ran, true)
    assert.equal(res.exitCode, 3)
    assert.match(res.outcomeSummary ?? '', /failed/)

    const { hooks } = await listCursorHooks({ workspaceRoot: root, projectTrusted: true })
    const row = hooks.find((h) => h.command === command)
    assert.ok(row, 'the seeded hook should be discovered')
    assert.equal(row.lastError, undefined, 'dry-run must not record a runtime failure')
  })
})
