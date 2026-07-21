// Payload snapshot tests (G4 of docs/plans/hooks-and-feature-packs.md).
//
// Decision 14: "Payloads are treated as stable now; stability is *declared* at
// publish time. Pre-v1 with zero consumers we don't version payloads, but every
// dialect wire payload is snapshot-tested (G4) so the publish-time stability
// audit is a diff review."
//
// This test marshals **every dialect wire request payload** — the stdin JSON a
// Cursor / Claude / Copse hook actually receives — for every canonical event
// each dialect declares a marshaller for (including the tool-flavor splits:
// shell / MCP / read for `toolGate`, shell / MCP for `afterToolUse`), stamps a
// fixed agent-session identity (B4 model fields), and compares the result
// against the committed golden fixture `__snapshots__/wire-payloads.json`.
//
// The *request direction is the stability contract* (a hook parses what we
// send); response interpretation is exercised by the per-adapter contract tests
// (`cursor-adapter.test.ts` / `claude-adapter.test.ts` / `copse-adapter.test.ts`).
//
// **Changing a snapshot is a publish-time stability audit.** When this test
// fails, a wire payload shape changed. Regenerate the fixture with
//
//   UPDATE_HOOK_PAYLOAD_SNAPSHOTS=1 npm test -- --test-name-pattern 'payload-snapshots'
//
// (or just re-run `npm test` with that env set) and **review the JSON diff**:
// pre-v1 with zero consumers we do not version payloads, so the reviewed diff of
// this committed file *is* the stability declaration (decision 14). An
// unreviewed / accidental shape change is exactly what this guard turns into a
// mechanical failure.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionInfo } from '@copse/agent/hooks/canonical-events.ts'
import type { CommandHook, HookDialect } from '@copse/agent/hooks/command-executor.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import type { DialectAdapter } from './dialect-adapter.ts'
import { cursorAdapter } from './cursor-adapter.ts'
import { claudeAdapter } from './claude-adapter.ts'
import { copseAdapter } from './copse-adapter.ts'

/** Committed golden fixture, resolved from the repo root (tests run with cwd = repo root). */
const SNAPSHOT_PATH = join(
  process.cwd(),
  'src/main/services/hooks/__snapshots__/wire-payloads.json',
)

/** Whether to (re)write the committed fixture instead of asserting against it. */
const UPDATE = process.env['UPDATE_HOOK_PAYLOAD_SNAPSHOTS'] === '1'

/**
 * A fixed workspace root so `workspace_roots` / `cwd` in every marshalled
 * payload is deterministic (marshallers read `getWorkspaceRoot()`). A literal
 * POSIX string keeps the fixture byte-stable across machines.
 */
const FIXTURE_ROOT = '/fixture/workspace'
const READ_PATH = `${FIXTURE_ROOT}/README.md`
const EDIT_PATH = `${FIXTURE_ROOT}/src/example.ts`
const SHELL_COMMAND = 'echo "hello from a hook"'
const MCP_TOOL = 'mcp__example__run'

/**
 * A fixed agent-session identity (B4) stamped onto every payload. Carrying a
 * `model` snapshots the *maximal* wire shape — the conditional model fields the
 * Cursor / Copse envelopes add and the optional `model` Claude's `SessionStart`
 * adds — so the golden fixture pins the full contract, not a degenerate one.
 */
const SESSION: AgentSessionInfo = {
  conversationId: 'conv-fixture-1',
  generationId: 'gen-fixture-1',
  model: {
    model: 'claude-sonnet-4',
    modelId: 'anthropic/claude-sonnet-4',
    modelParams: [
      { id: 'context', value: '1m' },
      { id: 'thinking', value: 'high' },
    ],
  },
}

/**
 * A representative registered command hook. Every adapter marshaller ignores
 * the hook argument (the wire shape is a function of the payload + session), so
 * one shared value drives all cases; the placeholder `event` is irrelevant.
 */
const HOOK: CommandHook = {
  id: 'snapshot-hook',
  event: 'toolGate',
  executor: 'command',
  dialect: 'copse',
  command: 'snapshot-hook.sh',
  onFailure: 'open',
}

const cursorAfterToolHook = (wireEvent: 'postToolUse' | 'postToolUseFailure'): CommandHook => ({
  ...HOOK,
  dialect: 'cursor',
  wireEvent,
})

/**
 * One wire payload to snapshot: a label (canonical event + optional flavor) and
 * the marshal call. The closure calls the adapter's marshaller with a concrete,
 * fully-typed payload literal, returning the wire request or `null`/`undefined`
 * when the dialect has no marshaller for the event (a foreign dialect that never
 * fires it) — such cases are simply absent from that dialect's snapshot.
 */
interface SnapshotCase {
  label: string
  marshal: (adapter: DialectAdapter) => unknown
  dialects?: HookDialect[]
}

const CASES: SnapshotCase[] = [
  {
    label: 'toolGate/shell',
    marshal: (a) =>
      a.marshalToolGateRequest(
        HOOK,
        { toolName: 'run_shell', input: { command: SHELL_COMMAND } },
        SESSION,
      ),
  },
  {
    label: 'toolGate/mcp',
    marshal: (a) =>
      a.marshalToolGateRequest(
        HOOK,
        { toolName: MCP_TOOL, input: { query: 'weather', limit: 3 } },
        SESSION,
      ),
  },
  {
    label: 'toolGate/read',
    marshal: (a) =>
      a.marshalToolGateRequest(
        HOOK,
        {
          toolName: 'read_file',
          input: { path: READ_PATH },
          fileContent: 'synthetic file bytes\n',
        },
        SESSION,
      ),
  },
  {
    label: 'beforeSubmitPrompt',
    marshal: (a) =>
      a.marshalBeforeSubmitPromptRequest?.(HOOK, { prompt: 'Fix the failing test.' }, SESSION),
  },
  {
    label: 'afterFileEdit',
    marshal: (a) => a.marshalAfterFileEditRequest?.(HOOK, { filePath: EDIT_PATH }, SESSION),
  },
  {
    label: 'stop',
    marshal: (a) => a.marshalStopRequest?.(HOOK, { status: 'completed' }, SESSION),
  },
  {
    label: 'afterToolUse/shell',
    marshal: (a) =>
      a.marshalAfterToolUseRequest?.(
        HOOK,
        {
          toolName: 'run_shell',
          toolCallId: 'call-shell-1',
          isError: false,
          input: { command: SHELL_COMMAND },
          output: 'hello from a hook\n',
          durationMs: 42,
        },
        SESSION,
      ),
  },
  {
    label: 'afterToolUse/mcp',
    marshal: (a) =>
      a.marshalAfterToolUseRequest?.(
        HOOK,
        {
          toolName: MCP_TOOL,
          toolCallId: 'call-mcp-1',
          isError: false,
          input: { query: 'weather', limit: 3 },
          output: '{"result":"sunny"}',
          durationMs: 108,
        },
        SESSION,
      ),
  },
  {
    label: 'afterToolUse/postToolUse',
    dialects: ['cursor'],
    marshal: (a) =>
      a.marshalAfterToolUseRequest?.(
        cursorAfterToolHook('postToolUse'),
        {
          toolName: 'read_file',
          toolCallId: 'call-read-1',
          isError: false,
          input: { path: READ_PATH },
          output: 'README contents\n',
          durationMs: 15,
        },
        SESSION,
      ),
  },
  {
    label: 'afterToolUse/postToolUseFailure',
    dialects: ['cursor'],
    marshal: (a) =>
      a.marshalAfterToolUseRequest?.(
        cursorAfterToolHook('postToolUseFailure'),
        {
          toolName: 'run_shell',
          toolCallId: 'call-shell-failed-1',
          isError: true,
          input: { command: 'exit 1' },
          output: 'Error: command failed',
          durationMs: 21,
        },
        SESSION,
      ),
  },
  {
    label: 'subagentStart',
    marshal: (a) => a.marshalSubagentStartRequest?.(HOOK, { subagentType: 'explore' }, SESSION),
  },
  {
    label: 'subagentStop',
    marshal: (a) =>
      a.marshalSubagentStopRequest?.(
        HOOK,
        { subagentType: 'explore', status: 'completed' },
        SESSION,
      ),
  },
  {
    label: 'sessionStart',
    marshal: (a) => a.marshalSessionStartRequest?.(HOOK, { firstTurn: true }, SESSION),
  },
  {
    label: 'beforeDiffApply',
    marshal: (a) => a.marshalBeforeDiffApplyRequest?.(HOOK, { filePath: EDIT_PATH }, SESSION),
  },
  {
    label: 'afterDiffApply',
    marshal: (a) =>
      a.marshalAfterDiffApplyRequest?.(HOOK, { filePath: EDIT_PATH, applied: true }, SESSION),
  },
  {
    label: 'permissionDecision',
    marshal: (a) =>
      a.marshalPermissionDecisionRequest?.(
        HOOK,
        { toolName: 'run_shell', decision: 'allow' },
        SESSION,
      ),
  },
  {
    label: 'postTurnReview',
    marshal: (a) =>
      a.marshalPostTurnReviewRequest?.(
        HOOK,
        { issuesFound: true, summary: 'The diff drops error handling in fetchUser().' },
        SESSION,
      ),
  },
]

/** The adapters, in the plan's dialect order (Cursor / Claude / Copse). */
const ADAPTERS: DialectAdapter[] = [cursorAdapter, claudeAdapter, copseAdapter]

/** Every dialect × supported-event wire payload, keyed by dialect then case label. */
function buildSnapshot(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const adapter of ADAPTERS) {
    const dialectOut: Record<string, unknown> = {}
    for (const c of CASES) {
      if (c.dialects && !c.dialects.includes(adapter.dialect)) continue
      const request = c.marshal(adapter)
      // null (marshaller declined — tool does not apply) / undefined (no
      // marshaller for the event) means this dialect does not send this payload.
      if (request === null || request === undefined) continue
      dialectOut[c.label] = request
    }
    out[adapter.dialect] = dialectOut
  }
  return out
}

/** Serialize identically to how the fixture is written, so the diff is byte-stable. */
function serialize(snapshot: unknown): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

describe('hook payload snapshots (G4, decision 14)', () => {
  let restoreRoot: () => void = () => {}

  before(() => {
    restoreRoot = setWorkspaceRootForTest(FIXTURE_ROOT)
  })

  after(() => {
    restoreRoot()
  })

  it('every dialect wire request payload matches the committed golden fixture', async () => {
    const snapshot = buildSnapshot()
    const serialized = serialize(snapshot)

    if (UPDATE) {
      await mkdir(join(process.cwd(), 'src/main/services/hooks/__snapshots__'), { recursive: true })
      await writeFile(SNAPSHOT_PATH, serialized, 'utf-8')
      return
    }

    let committed: string
    try {
      committed = await readFile(SNAPSHOT_PATH, 'utf-8')
    } catch {
      assert.fail(
        `Missing golden fixture ${SNAPSHOT_PATH}. Regenerate it with ` +
          `UPDATE_HOOK_PAYLOAD_SNAPSHOTS=1 npm test and review the diff (decision 14).`,
      )
    }

    // Byte-exact comparison so the committed file is exactly regenerable and the
    // stability audit is a clean JSON diff (decision 14). A mismatch means a wire
    // shape changed — review the diff, then regenerate.
    assert.equal(
      serialized,
      committed,
      'A dialect wire payload changed. This is a publish-time stability audit ' +
        '(docs/plans/hooks-and-feature-packs.md, decision 14): review the diff, then ' +
        'regenerate with UPDATE_HOOK_PAYLOAD_SNAPSHOTS=1 npm test.',
    )
  })

  it('snapshots every supported event for every dialect (no silent gaps)', () => {
    const snapshot = buildSnapshot()

    // Cursor gates + observes tools and lifecycle events, but has no Copse-native
    // diff/permission/review events.
    assert.deepEqual(Object.keys(snapshot['cursor'] ?? {}).sort(), [
      'afterFileEdit',
      'afterToolUse/mcp',
      'afterToolUse/postToolUse',
      'afterToolUse/postToolUseFailure',
      'afterToolUse/shell',
      'beforeSubmitPrompt',
      'sessionStart',
      'stop',
      'subagentStart',
      'subagentStop',
      'toolGate/mcp',
      'toolGate/read',
      'toolGate/shell',
    ])

    // Claude wires only the PreToolUse gate (3 tool flavors) + SessionStart.
    assert.deepEqual(Object.keys(snapshot['claude'] ?? {}).sort(), [
      'sessionStart',
      'toolGate/mcp',
      'toolGate/read',
      'toolGate/shell',
    ])

    // Copse is the native dialect: every supported event, including the
    // Copse-native diff/permission/review events.
    assert.deepEqual(Object.keys(snapshot['copse'] ?? {}).sort(), [
      'afterDiffApply',
      'afterFileEdit',
      'afterToolUse/mcp',
      'afterToolUse/shell',
      'beforeDiffApply',
      'beforeSubmitPrompt',
      'permissionDecision',
      'postTurnReview',
      'sessionStart',
      'stop',
      'subagentStart',
      'subagentStop',
      'toolGate/mcp',
      'toolGate/read',
      'toolGate/shell',
    ])
  })
})
