// Dry-run hook tester (G2 of docs/plans/hooks-and-feature-packs.md).
//
// The `hooks:test` IPC lets Settings → Sources run a single discovered hook
// **once** against a *synthetic* payload for its event and shows the raw
// stdin / stdout / stderr / exit / duration plus a derived parse_ok + outcome
// summary. It is deliberately a SIDE-EFFECT-FREE probe:
//
//   - it never records the spine (`recordCommandHookRun`) — a dry run is not a
//     real hook execution and must not appear in any thread's history;
//   - it never propagates session env (H4) or records a Sources per-hook
//     `lastError` (`recordRuntimeFailure`) — a dry run must not mutate the
//     session/Sources state a real run would;
//   - it never applies the normalized outcome — no decision is enforced, no
//     turn is started, no permission is granted (the outcome is *displayed*).
//
// So it does NOT reuse `createCommandHookRunner().run()` (which records the
// spine + runtime failures + threads session env). Instead it reuses only the
// pure seams: the dialect adapter's marshal/interpret (A2) and the shared
// {@link spawnHookProcess} (A2/F3), which is the same spawn a live run uses —
// sandboxed-by-default per F3 (macOS-only enforcement; a default, not a
// guarantee) so the dry run faithfully reproduces the live spawn boundary.
//
// This module lives host-side (`src/main/services/hooks/`) per execution-guidance
// rule 4: synthesizing wire payloads + spawning is Electron-adjacent, never
// `packages/agent`.
import { dirname, join } from 'node:path'
import type { CommandHook, HookDialect } from '@copse/agent/hooks/command-executor.ts'
import type {
  AfterToolUsePayload,
  ToolGatePayload,
  HookEventName,
} from '@copse/agent/hooks/canonical-events.ts'
import { HOOK_EVENT_NAMES } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome } from '@copse/agent/hooks/hook-outcome.ts'
import type { HookTestRequest, HookTestResult } from '@shared/types/hooks.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { getDialectAdapter } from './dialect-registry.ts'
import type { DialectAdapter, DialectInterpretation } from './dialect-adapter.ts'
import { spawnHookProcess, type HookSpawnResult } from './hook-spawn.ts'

/**
 * Bounded timeout for a dry run (ms). Independent of the vendor per-hook
 * timeout defaults (30s Cursor / 600s Claude) so the tester stays responsive —
 * a hung hook is killed after this and surfaced as `timedOut`, rather than
 * blocking the Settings UI for minutes.
 */
export const DRY_RUN_TIMEOUT_MS = 15_000

/** A synthetic MCP tool id used when synthesizing an MCP-flavored payload. */
const SYNTHETIC_MCP_TOOL = 'mcp__example__run'

/** A synthetic shell command the dry run proposes (never executed by Copse — only marshalled). */
const SYNTHETIC_SHELL_COMMAND = 'echo "copse hook dry-run"'

/** Where a dry run resolves a synthetic file path when there is no workspace open. */
function syntheticRoot(): string {
  return getWorkspaceRoot() ?? process.cwd()
}

/**
 * What a wire event maps to for a dry run: the canonical event to synthesize a
 * payload for, and (for the tool-flavored events) the canonical tool name that
 * selects the wire flavor the user is testing (`run_shell` → shell,
 * `mcp__…` → MCP, `read_file` → read).
 */
interface DryRunPlan {
  canonicalEvent: HookEventName
  toolName?: string
  isError?: boolean
}

/**
 * Map a Cursor wire event (as shown in Sources) to its dry-run plan. Cursor's
 * `beforeShell`/`beforeMCP`/`beforeReadFile` all map onto the canonical
 * `toolGate` (the tool name selects the flavor); `afterShell`/`afterMCP` map
 * onto `afterToolUse`; the rest are 1:1. Returns null for events with no
 * dry-runnable payload.
 */
function cursorPlan(wireEvent: string): DryRunPlan | null {
  switch (wireEvent) {
    case 'beforeShellExecution':
      return { canonicalEvent: 'toolGate', toolName: 'run_shell' }
    case 'beforeMCPExecution':
      return { canonicalEvent: 'toolGate', toolName: SYNTHETIC_MCP_TOOL }
    case 'beforeReadFile':
      return { canonicalEvent: 'toolGate', toolName: 'read_file' }
    case 'afterShellExecution':
      return { canonicalEvent: 'afterToolUse', toolName: 'run_shell' }
    case 'afterMCPExecution':
      return { canonicalEvent: 'afterToolUse', toolName: SYNTHETIC_MCP_TOOL }
    case 'postToolUse':
      return { canonicalEvent: 'afterToolUse', toolName: 'run_shell', isError: false }
    case 'postToolUseFailure':
      return { canonicalEvent: 'afterToolUse', toolName: 'run_shell', isError: true }
    case 'beforeSubmitPrompt':
      return { canonicalEvent: 'beforeSubmitPrompt' }
    case 'afterFileEdit':
      return { canonicalEvent: 'afterFileEdit' }
    case 'stop':
      return { canonicalEvent: 'stop' }
    case 'subagentStart':
      return { canonicalEvent: 'subagentStart' }
    case 'subagentStop':
      return { canonicalEvent: 'subagentStop' }
    case 'sessionStart':
      return { canonicalEvent: 'sessionStart' }
    default:
      return null
  }
}

/** Map a Claude wire event to its dry-run plan (`PreToolUse` gate / `SessionStart`). */
function claudePlan(wireEvent: string): DryRunPlan | null {
  switch (wireEvent) {
    case 'PreToolUse':
      return { canonicalEvent: 'toolGate', toolName: 'run_shell' }
    case 'SessionStart':
      return { canonicalEvent: 'sessionStart' }
    default:
      return null
  }
}

function isCanonicalEvent(value: string): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(value)
}

/**
 * Map a Copse wire event to its dry-run plan. Copse is the native dialect, so
 * its Sources `event` is already a canonical event name; the tool-flavored
 * events default to a shell payload.
 */
function copsePlan(wireEvent: string): DryRunPlan | null {
  if (!isCanonicalEvent(wireEvent)) return null
  const toolName =
    wireEvent === 'toolGate' || wireEvent === 'afterToolUse' ? 'run_shell' : undefined
  return toolName !== undefined
    ? { canonicalEvent: wireEvent, toolName }
    : { canonicalEvent: wireEvent }
}

/** Resolve the dry-run plan for a (family, wire event) pair, or null when it cannot be tested. */
export function dryRunPlanFor(family: HookDialect, wireEvent: string): DryRunPlan | null {
  switch (family) {
    case 'cursor':
      return cursorPlan(wireEvent)
    case 'claude':
      return claudePlan(wireEvent)
    case 'copse':
      return copsePlan(wireEvent)
  }
}

function buildToolGatePayload(toolName: string): ToolGatePayload {
  if (toolName === 'read_file') {
    return {
      toolName,
      input: { path: join(syntheticRoot(), 'README.md') },
      fileContent: 'Synthetic file contents for the hook dry-run tester.\n',
    }
  }
  if (toolName.startsWith('mcp__')) {
    return { toolName, input: { example: 'value' } }
  }
  return { toolName, input: { command: SYNTHETIC_SHELL_COMMAND } }
}

function buildAfterToolUsePayload(toolName: string, isError = false): AfterToolUsePayload {
  return {
    toolName,
    toolCallId: 'dry-run-tool-call',
    isError,
    input: toolName.startsWith('mcp__')
      ? { example: 'value' }
      : { command: SYNTHETIC_SHELL_COMMAND },
    output: 'synthetic tool output',
    durationMs: 12,
  }
}

/**
 * Build the synthetic canonical payload a dry run would feed a hook for `plan`.
 * Exposed so payload synthesis is unit-testable independently of spawning. The
 * shape matches the canonical event's payload interface exactly (the same value
 * {@link marshalDryRun} feeds the adapter), so a dialect marshaller sees a
 * well-formed payload. Returns null for events with no dry-runnable payload
 * (first-party assembly events + `compaction`).
 */
export function synthesizeCanonicalPayload(plan: DryRunPlan): Record<string, unknown> | null {
  const event = plan.canonicalEvent
  switch (event) {
    case 'toolGate':
      return { ...buildToolGatePayload(plan.toolName ?? 'run_shell') }
    case 'afterToolUse':
      return { ...buildAfterToolUsePayload(plan.toolName ?? 'run_shell', plan.isError) }
    case 'beforeSubmitPrompt':
      return { prompt: 'This is a synthetic prompt from the hook dry-run tester.' }
    case 'afterFileEdit':
    case 'beforeDiffApply':
      return { filePath: join(syntheticRoot(), 'src', 'example.ts') }
    case 'afterDiffApply':
      return { filePath: join(syntheticRoot(), 'src', 'example.ts'), applied: true }
    case 'stop':
      return { status: 'completed' }
    case 'subagentStart':
      return { subagentType: 'explore' }
    case 'subagentStop':
      return { subagentType: 'explore', status: 'completed' }
    case 'sessionStart':
      return { firstTurn: true }
    case 'permissionDecision':
      return { toolName: 'run_shell', decision: 'allow' }
    case 'postTurnReview':
      return {
        issuesFound: false,
        summary: 'Synthetic review summary for the hook dry-run tester.',
      }
    case 'turnStart':
    case 'beforeFinalize':
    case 'stepBoundary':
    case 'compaction':
      return null
  }
}

/**
 * The marshalled stdin payload for a dry run plus the closure that interprets
 * the spawn per the dialect. Built inline per canonical event so each payload
 * literal keeps its concrete type (no casts). Returns null when the dialect has
 * no marshaller for the event (a foreign dialect that never fires it) — the
 * dry run then reports "unsupported".
 */
interface MarshalledDryRun {
  request: unknown
  interpret: (spawn: HookSpawnResult) => DialectInterpretation
}

function marshalDryRun(
  adapter: DialectAdapter,
  hook: CommandHook,
  plan: DryRunPlan,
): MarshalledDryRun | null {
  const event = plan.canonicalEvent
  // A dry run is a standalone probe with no active run, so no agent-session
  // identity is stamped (marshallers emit empty conversation/generation ids —
  // the pre-B4 behavior). Passing `undefined` is honest: nothing is running.
  const session = undefined
  switch (event) {
    case 'toolGate': {
      const payload = buildToolGatePayload(plan.toolName ?? 'run_shell')
      return {
        request: adapter.marshalToolGateRequest(hook, payload, session),
        interpret: (s) => adapter.interpretToolGate(s, payload),
      }
    }
    case 'afterToolUse': {
      const marshal = adapter.marshalAfterToolUseRequest?.bind(adapter)
      const interpret = adapter.interpretAfterToolUse?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = buildAfterToolUsePayload(plan.toolName ?? 'run_shell', plan.isError)
      return {
        request: marshal(hook, payload, session),
        interpret: (s) => interpret(s, payload, hook),
      }
    }
    case 'beforeSubmitPrompt': {
      const marshal = adapter.marshalBeforeSubmitPromptRequest?.bind(adapter)
      const interpret = adapter.interpretBeforeSubmitPrompt?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { prompt: 'This is a synthetic prompt from the hook dry-run tester.' }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'afterFileEdit': {
      const marshal = adapter.marshalAfterFileEditRequest?.bind(adapter)
      const interpret = adapter.interpretAfterFileEdit?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { filePath: join(syntheticRoot(), 'src', 'example.ts') }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'stop': {
      const marshal = adapter.marshalStopRequest?.bind(adapter)
      const interpret = adapter.interpretStop?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { status: 'completed' as const }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'subagentStart': {
      const marshal = adapter.marshalSubagentStartRequest?.bind(adapter)
      const interpret = adapter.interpretSubagentStart?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { subagentType: 'explore' }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'subagentStop': {
      const marshal = adapter.marshalSubagentStopRequest?.bind(adapter)
      const interpret = adapter.interpretSubagentStop?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { subagentType: 'explore', status: 'completed' as const }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'sessionStart': {
      const marshal = adapter.marshalSessionStartRequest?.bind(adapter)
      const interpret = adapter.interpretSessionStart?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { firstTurn: true }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'beforeDiffApply': {
      const marshal = adapter.marshalBeforeDiffApplyRequest?.bind(adapter)
      const interpret = adapter.interpretBeforeDiffApply?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { filePath: join(syntheticRoot(), 'src', 'example.ts') }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'afterDiffApply': {
      const marshal = adapter.marshalAfterDiffApplyRequest?.bind(adapter)
      const interpret = adapter.interpretAfterDiffApply?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { filePath: join(syntheticRoot(), 'src', 'example.ts'), applied: true }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'permissionDecision': {
      const marshal = adapter.marshalPermissionDecisionRequest?.bind(adapter)
      const interpret = adapter.interpretPermissionDecision?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = { toolName: 'run_shell', decision: 'allow' as const }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    case 'postTurnReview': {
      const marshal = adapter.marshalPostTurnReviewRequest?.bind(adapter)
      const interpret = adapter.interpretPostTurnReview?.bind(adapter)
      if (!marshal || !interpret) return null
      const payload = {
        issuesFound: false,
        summary: 'Synthetic review summary for the hook dry-run tester.',
      }
      return { request: marshal(hook, payload, session), interpret: (s) => interpret(s, payload) }
    }
    // First-party assembly events + `compaction` have no command-hook fire site
    // and no dialect marshaller — a dry run cannot exercise them.
    case 'turnStart':
    case 'beforeFinalize':
    case 'stepBoundary':
    case 'compaction':
      return null
  }
}

/** Truncate a message for the one-line outcome summary. */
function clip(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Condense a dialect interpretation into a one-line summary for the tester.
 * A failed run (crash / timeout / invalid JSON) reports the runtime error; a
 * clean run reports the normalized outcome fields, or "no opinion" when the
 * hook abstained. Note this is display-only — no decision is ever applied.
 */
export function summarizeInterpretation(interp: DialectInterpretation): string {
  if (interp.failed) {
    return interp.runtimeError ? `failed — ${interp.runtimeError}` : 'failed'
  }
  const parts = summarizeOutcomeParts(interp.outcome)
  if (interp.queueMessage)
    parts.push(`queued message (${String(interp.queueMessage.text.length)} chars)`)
  return parts.length > 0 ? parts.join('; ') : 'no opinion'
}

function summarizeOutcomeParts(outcome: BlockingHookOutcome | null): string[] {
  if (!outcome) return []
  const parts: string[] = []
  if (outcome.haltRun) parts.push(`halt — ${clip(outcome.haltRun.reason)}`)
  if (outcome.decision) parts.push(outcome.decision)
  if (outcome.updatedInput) parts.push('rewrote input')
  if (outcome.injectContext !== undefined) {
    parts.push(`inject ${String(outcome.injectContext.length)} chars`)
  }
  if (outcome.agentMessage) parts.push(`agent: ${clip(outcome.agentMessage)}`)
  if (outcome.userMessage) parts.push(`user: ${clip(outcome.userMessage)}`)
  return parts
}

/**
 * Run one discovered hook once against a synthetic payload for its event and
 * return everything observed (stdin/stdout/stderr/exit/duration + parse_ok +
 * outcome summary). Never mutates live agent state (no spine, no session env,
 * no Sources error state) and never applies the outcome — see the module
 * header. When the event has no dry-runnable payload for its dialect, returns
 * `{ ran: false, error }` without spawning anything.
 */
export async function dryRunHook(req: HookTestRequest): Promise<HookTestResult> {
  const dialect: HookDialect = req.family
  const adapter = getDialectAdapter(dialect)
  if (!adapter) {
    return { ran: false, error: `No adapter for the "${dialect}" dialect.` }
  }

  const plan = dryRunPlanFor(dialect, req.event)
  if (!plan) {
    return {
      ran: false,
      error: `The "${req.event}" event has no synthetic payload to dry-run (unsupported).`,
    }
  }

  const hook: CommandHook = {
    id: req.command,
    event: plan.canonicalEvent,
    executor: 'command',
    dialect,
    wireEvent: req.event,
    command: req.command,
    // A dry run never applies failure resolution, so `onFailure` is irrelevant;
    // `open` keeps the reconstructed hook shape valid without implying a policy.
    onFailure: 'open',
    cwd: req.source ? dirname(req.source) : process.cwd(),
    ...(req.sandbox !== undefined ? { sandbox: req.sandbox } : {}),
  }

  const marshalled = marshalDryRun(adapter, hook, plan)
  if (!marshalled) {
    return {
      ran: false,
      error: `The "${dialect}" dialect has no "${plan.canonicalEvent}" hook to dry-run.`,
      canonicalEvent: plan.canonicalEvent,
    }
  }

  if (marshalled.request === null) {
    // The marshaller declined to build a request (the hook does not apply to
    // the synthetic tool) — nothing to spawn.
    return {
      ran: false,
      error: 'The hook does not apply to the synthetic payload for this event.',
      canonicalEvent: plan.canonicalEvent,
    }
  }

  const spawn = await spawnHookProcess(hook.command, marshalled.request, {
    cwd: hook.cwd ?? process.cwd(),
    timeoutMs: DRY_RUN_TIMEOUT_MS,
    ...(req.sandbox !== undefined ? { sandbox: req.sandbox } : {}),
  })

  const interp = marshalled.interpret(spawn)

  return {
    ran: true,
    canonicalEvent: plan.canonicalEvent,
    wireEvent: interp.spineEvent,
    stdin: JSON.stringify(marshalled.request, null, 2),
    stdout: spawn.stdout,
    stderr: spawn.stderr,
    exitCode: spawn.exitCode,
    durationMs: spawn.durationMs,
    timedOut: spawn.timedOut,
    spawnError: spawn.spawnError,
    sandboxed: spawn.sandboxed,
    parseOk: interp.parseOk,
    outcomeSummary: summarizeInterpretation(interp),
  }
}
