// Cursor dialect adapter (decision 8) — `.cursor/hooks.json`.
//
// Owns everything Cursor-specific: discovery of `~/.cursor/hooks.json` and
// `<root>/.cursor/hooks.json`, parsing (including the per-hook `failClosed`
// flag), the tool → event matcher, wire marshalling in both directions, and the
// per-event exit-code table that decides fail-open vs failClosed (decision 9).
// Foreign-file discipline: only Cursor's own event names are honoured; unknown
// events are warned about, never silently skipped.
//
// Cursor hooks fail **open by default** — a crash, timeout, or invalid JSON is
// treated as `allow` so a broken hook never wedges the agent. But Cursor's
// per-hook `failClosed: true` is part of the vendor contract: with it set, those
// same failures **block** (decision 9 acceptance criterion). The adapter reports
// `failed` + the hook's `onFailure`; the shared runner turns that into deny/allow.
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CURSOR_HOOK_EVENTS,
  isCursorWiredHookEvent,
  type CursorHookEvent,
  type CursorHookScope,
  type CursorHooksListResult,
  type CursorHookValidationWarning,
  type CursorPermissionHookEvent,
} from '@shared/types/cursor-hooks.ts'
import type { HooksListResult } from '@shared/types/hooks.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome, HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import type {
  DialectAdapter,
  DialectDiscoverOpts,
  DialectInterpretation,
} from './dialect-adapter.ts'
import { DEFAULT_HOOK_TIMEOUT_MS, type HookSpawnResult } from './hook-spawn.ts'

/** A parsed hook command together with the config that declared it. */
interface DiscoveredCursorHook {
  event: CursorHookEvent
  command: string
  /** Directory of the declaring `hooks.json`; relative commands resolve against it. */
  cwd: string
  source: string
  scope: CursorHookScope
  /** Cursor `failClosed: true` — crash / timeout / invalid JSON blocks instead of allowing. */
  failClosed: boolean
}

/** `~/.cursor/hooks.json` — always trusted (the user installed it). */
export function userHooksConfigPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

/** `<root>/.cursor/hooks.json` — only honoured when the workspace is trusted. */
export function projectHooksConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.cursor', 'hooks.json')
}

function isHookEvent(value: string): value is CursorHookEvent {
  return (CURSOR_HOOK_EVENTS as readonly string[]).includes(value)
}

/** One parsed config: usable hooks plus per-entry authoring warnings. */
interface ParsedHooksConfig {
  hooks: DiscoveredCursorHook[]
  warnings: CursorHookValidationWarning[]
}

/**
 * Parse one `hooks.json`. The shape is `{ version, hooks: { <event>: [{ command }] } }`.
 * Unknown events and malformed entries are skipped rather than throwing — a bad hook
 * config should never break the agent loop — but each skip is surfaced as a warn-level
 * validation warning so the Sources panel can show authoring problems (G3: a warn-level
 * lint, never a load gate). Unknown events are warned about, never silently dropped
 * (decision 8).
 */
async function parseHooksConfig(path: string, scope: CursorHookScope): Promise<ParsedHooksConfig> {
  const warnings: CursorHookValidationWarning[] = []
  const warn = (message: string): void => {
    warnings.push({ source: path, scope, message })
  }

  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf-8')
  } catch {
    // A missing config is the normal case, not an authoring problem.
    return { hooks: [], warnings }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('hooks.json is not valid JSON — file ignored')
    return { hooks: [], warnings }
  }

  // parsed comes from JSON.parse and can legitimately be null (e.g. `null`/`false`);
  // the cast type hides that, so the optional chain guards the real runtime case.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hooks = (parsed as { hooks?: unknown })?.hooks
  if (typeof hooks !== 'object' || hooks === null) {
    warn('hooks.json has no "hooks" object — file ignored')
    return { hooks: [], warnings }
  }

  const cwd = dirname(path)
  const out: DiscoveredCursorHook[] = []
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!isHookEvent(event)) {
      warn(`Unknown hook event "${event}" — entries skipped`)
      continue
    }
    if (!Array.isArray(entries)) {
      warn(`"${event}" must be an array of { command } entries — skipped`)
      continue
    }
    entries.forEach((entry, index) => {
      // entry is an element of a parsed JSON array and can be null; the cast type
      // hides that, so the optional chain guards the genuine runtime case.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const command = (entry as { command?: unknown })?.command
      if (typeof command !== 'string' || !command.trim()) {
        warn(`"${event}" entry ${String(index + 1)} has a missing or empty "command" — skipped`)
        return
      }
      const failClosed = (entry as { failClosed?: unknown }).failClosed === true
      out.push({ event, command: command.trim(), cwd, source: path, scope, failClosed })
    })
  }
  return { hooks: out, warnings }
}

/**
 * Discover all hooks visible in the current context, with validation warnings.
 *
 * - User hooks (`~/.cursor/hooks.json`) are always discovered.
 * - Project hooks (`<root>/.cursor/hooks.json`) are only discovered when the workspace
 *   is trusted, because honouring them spawns scripts from a possibly-cloned repo.
 */
async function discoverHooksDetailed(opts: DialectDiscoverOpts): Promise<ParsedHooksConfig> {
  const configs: Array<Promise<ParsedHooksConfig>> = [
    parseHooksConfig(userHooksConfigPath(), 'user'),
  ]
  if (opts.workspaceRoot && opts.projectTrusted) {
    configs.push(parseHooksConfig(projectHooksConfigPath(opts.workspaceRoot), 'project'))
  }
  const results = await Promise.all(configs)
  return {
    hooks: results.flatMap((r) => r.hooks),
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * Runtime hook failures observed this session, keyed by command+event and recording
 * only the *first* failure per hook. Feeds the per-hook error indicator in Sources;
 * never affects fail-open / failClosed semantics.
 */
const sessionHookErrors = new Map<string, string>()

function hookErrorKey(event: string, command: string): string {
  return `${event}\u0000${command}`
}

/** Test-only: clear the per-session hook error state between cases. */
export function resetCursorHookSessionErrorsForTest(): void {
  sessionHookErrors.clear()
}

/**
 * Per-hook timeout applied to discovered Cursor hooks (decision 13; H4 makes
 * this configurable per hook). Kept as a module variable so tests can shorten it
 * to exercise the timeout failure mode without a 5s wall-clock wait.
 */
let cursorHookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS

/** Test-only: override the Cursor per-hook timeout, or reset to the default when omitted. */
export function setCursorHookTimeoutForTest(ms?: number): void {
  cursorHookTimeoutMs = ms ?? DEFAULT_HOOK_TIMEOUT_MS
}

/** Diagnostics / Settings → Sources — discovered Cursor hooks, regardless of enablement. */
export async function listCursorHooks(opts: DialectDiscoverOpts): Promise<CursorHooksListResult> {
  const { hooks, warnings } = await discoverHooksDetailed(opts)
  return {
    hooks: hooks.map(({ event, command, source, scope }) => {
      const lastError = sessionHookErrors.get(hookErrorKey(event, command))
      return {
        event,
        command,
        source,
        scope,
        supported: isCursorWiredHookEvent(event),
        ...(lastError !== undefined ? { lastError } : {}),
      }
    }),
    warnings,
  }
}

/** Cursor hooks + warnings in the shared shape used by `hooks:list`. */
export async function listCursorHooksForSources(
  opts: DialectDiscoverOpts,
): Promise<HooksListResult> {
  const { hooks, warnings } = await listCursorHooks(opts)
  return {
    hooks: hooks.map((h) => ({
      family: 'cursor' as const,
      event: h.event,
      command: h.command,
      source: h.source,
      scope: h.scope,
      supported: h.supported,
      ...(h.lastError !== undefined ? { lastError: h.lastError } : {}),
    })),
    warnings: warnings.map((w) => ({
      message: w.message,
      source: w.source,
      scope: w.scope,
    })),
  }
}

// ---------------------------------------------------------------------------
// tool → event matcher + wire marshalling (both directions)
// ---------------------------------------------------------------------------

/** Map a canonical tool name to the Cursor permission event that gates it, if any. */
export function cursorEventForTool(toolName: string): CursorPermissionHookEvent | null {
  if (toolName === 'run_shell') return 'beforeShellExecution'
  if (toolName.startsWith('mcp__')) return 'beforeMCPExecution'
  if (toolName === 'read_file') return 'beforeReadFile'
  return null
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Project (repo-supplied) hook commands already audit-logged this session, so we warn
 * at most once per distinct command rather than on every gated tool call.
 */
const warnedProjectHookCommands = new Set<string>()

function auditProjectHook(hook: DiscoveredCursorHook): void {
  if (hook.scope !== 'project') return
  if (warnedProjectHookCommands.has(hook.command)) return
  warnedProjectHookCommands.add(hook.command)
  console.warn(
    `[cursor-hooks] executing project (repo-supplied) hook for "${hook.event}": ${hook.command} ` +
      `(from ${hook.source}). Project hooks run outside the sandbox with tool tokens in env; ` +
      `see docs/cursor-hooks.md#security.`,
  )
}

/**
 * Discover the Cursor command hooks that gate `payload.toolName`, as registry
 * `CommandHook`s. Only permission events (shell / MCP / read) map onto the
 * canonical `toolGate`; the matcher is the tool → event mapping above. Each
 * hook's `onFailure` is `closed` when its `failClosed` flag is set, `open`
 * otherwise (the Cursor default).
 */
export async function cursorToolGateHooks(
  payload: HookEventPayloads['toolGate'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'toolGate'>[]> {
  const event = cursorEventForTool(payload.toolName)
  if (!event) return []
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === event)
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'toolGate' as const,
        executor: 'command' as const,
        dialect: 'cursor' as const,
        command: h.command,
        onFailure: h.failClosed ? ('closed' as const) : ('open' as const),
        cwd: h.cwd,
        timeoutMs: cursorHookTimeoutMs,
      }
    })
}

/**
 * Discover the Cursor command hooks registered for `beforeSubmitPrompt` (B1), as
 * registry `CommandHook`s. Same discovery + trust + `failClosed` → `onFailure`
 * mapping as {@link cursorToolGateHooks}; the compose-path fire site
 * (`before-submit-prompt.ts`) registers and fires them through the shared
 * registry → runner → adapter seam.
 */
export async function cursorBeforeSubmitPromptHooks(
  _payload: HookEventPayloads['beforeSubmitPrompt'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'beforeSubmitPrompt'>[]> {
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'beforeSubmitPrompt')
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'beforeSubmitPrompt' as const,
        executor: 'command' as const,
        dialect: 'cursor' as const,
        command: h.command,
        onFailure: h.failClosed ? ('closed' as const) : ('open' as const),
        cwd: h.cwd,
        timeoutMs: cursorHookTimeoutMs,
      }
    })
}

interface CursorHookResponse {
  permission?: HookDecision
  agentMessage?: string
  userMessage?: string
}

/**
 * Cursor `beforeSubmitPrompt` stdout: `{ continue: boolean }` plus an optional
 * user-facing message. The vendor documents `user_message` (snake_case); the
 * permission-hook response uses camelCase `userMessage`/`agentMessage`, so we
 * accept either spelling and normalize.
 */
interface CursorBeforeSubmitPromptResponse {
  continue?: boolean
  user_message?: string
  userMessage?: string
  agent_message?: string
  agentMessage?: string
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function isHookDecision(value: unknown): value is HookDecision {
  return value === 'allow' || value === 'deny' || value === 'ask'
}

function outcomeFromResponse(parsed: unknown): {
  outcome: BlockingHookOutcome | null
  spineDecision: SpineHookRunDecision
} {
  if (typeof parsed !== 'object' || parsed === null) return { outcome: null, spineDecision: {} }
  const res = parsed as CursorHookResponse
  const outcome: BlockingHookOutcome = {}
  if (isHookDecision(res.permission)) outcome.decision = res.permission
  if (typeof res.agentMessage === 'string' && res.agentMessage)
    outcome.agentMessage = res.agentMessage
  if (typeof res.userMessage === 'string' && res.userMessage) outcome.userMessage = res.userMessage
  const spineDecision: SpineHookRunDecision = {
    ...(outcome.decision !== undefined ? { permission: outcome.decision } : {}),
    ...(outcome.agentMessage !== undefined
      ? { agentMessageChars: outcome.agentMessage.length }
      : {}),
    ...(outcome.userMessage !== undefined ? { userMessageChars: outcome.userMessage.length } : {}),
  }
  return { outcome: Object.keys(outcome).length > 0 ? outcome : null, spineDecision }
}

/** The concrete Cursor dialect adapter the runner delegates to. */
export const cursorAdapter: DialectAdapter = {
  dialect: 'cursor',

  marshalToolGateRequest(_hook, payload) {
    const event = cursorEventForTool(payload.toolName)
    if (!event) return null
    const base = {
      conversation_id: '',
      generation_id: '',
      hook_event_name: event,
      workspace_roots: getWorkspaceRoot() ? [getWorkspaceRoot()] : [],
    }
    if (event === 'beforeShellExecution') {
      return {
        ...base,
        command: stringField(payload.input, 'command'),
        cwd: getWorkspaceRoot() ?? '',
      }
    }
    if (event === 'beforeMCPExecution') {
      return { ...base, tool_name: payload.toolName, tool_input: payload.input }
    }
    // beforeReadFile: content is passed after the gate today (B4 wires content).
    return { ...base, file_path: stringField(payload.input, 'path'), content: '' }
  },

  interpretToolGate(spawn: HookSpawnResult, payload): DialectInterpretation {
    const spineEvent = cursorEventForTool(payload.toolName) ?? 'toolGate'
    const emptyDecision: SpineHookRunDecision = {}
    const base = { outcome: null, spineEvent, spineDecision: emptyDecision }

    if (spawn.spawnError) {
      return { ...base, failed: true, parseOk: false, runtimeError: 'failed to start' }
    }
    if (spawn.timedOut) {
      return {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: `timed out after ${String(cursorHookTimeoutMs / 1000)}s`,
      }
    }

    const text = spawn.stdout.trim()
    if (!text) {
      // Empty stdout is an intentional no-response on a clean exit. A non-zero /
      // killed exit with no output is still a crash the vendor contract treats as
      // a failure (blocks under failClosed, allows otherwise).
      if (spawn.exitCode === 0) {
        return { ...base, failed: false, parseOk: true }
      }
      const detail =
        spawn.exitCode === null ? 'was killed' : `exited with code ${String(spawn.exitCode)}`
      return { ...base, failed: true, parseOk: true, runtimeError: detail }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: 'printed invalid JSON — response ignored',
      }
    }
    const { outcome, spineDecision } = outcomeFromResponse(parsed)
    return { outcome, spineEvent, spineDecision, failed: false, parseOk: true }
  },

  marshalBeforeSubmitPromptRequest(_hook, payload) {
    // Cursor's beforeSubmitPrompt stdin: the composed prompt plus attachments
    // (empty until an attachments payload channel exists) and the standard
    // agent-session envelope. B4 fills conversation/generation ids + model.
    return {
      conversation_id: '',
      generation_id: '',
      hook_event_name: 'beforeSubmitPrompt',
      workspace_roots: getWorkspaceRoot() ? [getWorkspaceRoot()] : [],
      prompt: payload.prompt,
      attachments: [],
    }
  },

  interpretBeforeSubmitPrompt(spawn: HookSpawnResult, _payload): DialectInterpretation {
    const spineEvent = 'beforeSubmitPrompt'
    const emptyDecision: SpineHookRunDecision = {}
    const base = { outcome: null, spineEvent, spineDecision: emptyDecision }

    if (spawn.spawnError) {
      return { ...base, failed: true, parseOk: false, runtimeError: 'failed to start' }
    }
    if (spawn.timedOut) {
      return {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: `timed out after ${String(cursorHookTimeoutMs / 1000)}s`,
      }
    }

    const text = spawn.stdout.trim()
    if (!text) {
      // No stdout on a clean exit is an intentional "allow / no opinion"; a
      // crash with no output is a failure the runner resolves per `onFailure`.
      if (spawn.exitCode === 0) return { ...base, failed: false, parseOk: true }
      const detail =
        spawn.exitCode === null ? 'was killed' : `exited with code ${String(spawn.exitCode)}`
      return { ...base, failed: true, parseOk: true, runtimeError: detail }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: 'printed invalid JSON — response ignored',
      }
    }
    const { outcome, spineDecision } = beforeSubmitOutcomeFromResponse(parsed)
    return { outcome, spineEvent, spineDecision, failed: false, parseOk: true }
  },

  recordRuntimeFailure(event, command, message) {
    const key = hookErrorKey(event, command)
    if (sessionHookErrors.has(key)) return
    sessionHookErrors.set(key, message)
  },
}

/**
 * Normalize a Cursor `beforeSubmitPrompt` response. `continue: false` halts the
 * submit (decision 12's `haltRun`); the user-facing message becomes the halt
 * reason and rides along as `userMessage` for surfacing (B1 acceptance: carry
 * `user_message` on halt). `agentMessage` is carried when present. Any other
 * `continue` value (true / absent) is an allow — no opinion.
 */
function beforeSubmitOutcomeFromResponse(parsed: unknown): {
  outcome: BlockingHookOutcome | null
  spineDecision: SpineHookRunDecision
} {
  if (typeof parsed !== 'object' || parsed === null) return { outcome: null, spineDecision: {} }
  const res = parsed as CursorBeforeSubmitPromptResponse
  const userMessage = firstString(res.user_message, res.userMessage)
  const agentMessage = firstString(res.agent_message, res.agentMessage)
  const outcome: BlockingHookOutcome = {}
  if (res.continue === false) {
    outcome.haltRun = {
      reason: userMessage ?? 'Prompt submission was blocked by a beforeSubmitPrompt hook.',
    }
  }
  if (userMessage !== undefined) outcome.userMessage = userMessage
  if (agentMessage !== undefined) outcome.agentMessage = agentMessage
  const spineDecision: SpineHookRunDecision = {
    ...(outcome.haltRun !== undefined ? { haltRun: true } : {}),
    ...(agentMessage !== undefined ? { agentMessageChars: agentMessage.length } : {}),
    ...(userMessage !== undefined ? { userMessageChars: userMessage.length } : {}),
  }
  return { outcome: Object.keys(outcome).length > 0 ? outcome : null, spineDecision }
}
