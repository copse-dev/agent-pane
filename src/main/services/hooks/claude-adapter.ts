// Claude Code dialect adapter (decision 8) — `.claude/settings.json`.
//
// Owns everything Claude-specific: discovery of `~/.claude/settings.json`,
// project `.claude/settings.json`, and `.claude/settings.local.json`; parsing
// the nested `hooks.PreToolUse` matcher groups; the tool-name matcher; wire
// marshalling in both directions (a Claude hook sees Claude's stdin shape and
// tool names — `Bash`, `Read`, `mcp__…`); and the exit-code table (decision 9):
// **exit 2 denies** (stderr → agent message), everything else fails open.
//
// Claude has no `failClosed` flag, so every hook's `onFailure` is `open`; exit-2
// is a *decision*, not a failure, so it is honoured directly rather than routed
// through the runner's failure resolution.
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudePermissionDecision } from '@shared/types/claude-hooks.ts'
import { CLAUDE_PERMISSION_DECISIONS } from '@shared/types/claude-hooks.ts'
import type {
  HookScope,
  HookSummary,
  HookValidationWarning,
  HooksListResult,
} from '@shared/types/hooks.ts'
import { isPublishedClaudeEvent } from '@shared/hooks/vendored-hook-schemas.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome, HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import type {
  DialectAdapter,
  DialectDiscoverOpts,
  DialectInterpretation,
} from './dialect-adapter.ts'
import { type HookSpawnResult } from './hook-spawn.ts'

/**
 * Claude's per-hook timeout default (decision 13; H4). Claude Code documents a
 * **600s** (10-minute) default for `command` / `http` / `mcp_tool` hooks,
 * overridable per hook via the `timeout` field, in seconds
 * (https://code.claude.com/docs/en/hooks). Copse's historical fixed 5s would
 * kill real Claude hooks, so H4 adopts the vendor default; per-hook `timeout`
 * still wins.
 */
export const CLAUDE_DEFAULT_HOOK_TIMEOUT_MS = 600_000

/**
 * Claude hook events Copse discovers from settings. `PreToolUse` (tool gate,
 * A2/B4) and `SessionStart` (H4 — fire-and-forget session lifecycle, the only
 * Claude agent-session event that carries an optional `model`, per the vendor
 * contract).
 */
type DiscoveredClaudeEvent = 'PreToolUse' | 'SessionStart'

/**
 * The Claude events Copse actually wires (discovers + fires): the `PreToolUse`
 * tool gate (A2/B4) and `SessionStart` (H4). Every other event the vendored
 * SchemaStore schema publishes is intentionally-unsupported v1 — the G3 drift
 * detector pins this set against `schemas/vendor/claude-code-settings.schema.json`.
 */
export const CLAUDE_WIRED_HOOK_EVENTS: readonly DiscoveredClaudeEvent[] = [
  'PreToolUse',
  'SessionStart',
]

/** A parsed Claude command hook ready to spawn. */
interface DiscoveredClaudeHook {
  event: DiscoveredClaudeEvent
  /**
   * Tool-name matcher for `PreToolUse` (`Bash`, `Edit|Write`, `mcp__.*`, `*`, or
   * omitted = all). For `SessionStart` the matcher is the session source
   * (`startup` / `resume` / `clear` / `compact`); Copse fires on new
   * conversations, so a matcher-less SessionStart hook always applies.
   */
  matcher?: string
  command: string
  /** Directory of the declaring settings file; relative commands resolve against it. */
  cwd: string
  source: string
  scope: HookScope
  /**
   * Per-hook `timeout` override in **milliseconds** (decision 13; H4), parsed
   * from the handler's `timeout` field (a number of **seconds**, Claude's wire
   * unit). Absent = the dialect default {@link CLAUDE_DEFAULT_HOOK_TIMEOUT_MS}.
   */
  timeoutMs?: number
}

/**
 * Normalize a Claude handler's `timeout` field (seconds) to milliseconds. A
 * valid positive, finite number is multiplied by 1000; anything else yields
 * undefined so the hook falls back to {@link CLAUDE_DEFAULT_HOOK_TIMEOUT_MS}.
 */
function normalizeClaudeTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * 1000)
}

/** `~/.claude/settings.json` — always trusted (the user installed it). */
export function userClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** `<root>/.claude/settings.json` — only honoured when the workspace is trusted. */
export function projectClaudeSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.claude', 'settings.json')
}

/**
 * `<root>/.claude/settings.local.json` — local overrides, typically gitignored.
 * Same trust gate as project settings.
 */
export function projectClaudeLocalSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.claude', 'settings.local.json')
}

function isPermissionDecision(value: unknown): value is ClaudePermissionDecision {
  return (
    typeof value === 'string' && (CLAUDE_PERMISSION_DECISIONS as readonly string[]).includes(value)
  )
}

/**
 * Whether a Claude matcher group applies to `toolName`.
 *
 * Mirrors Claude Code's matcher rules for tool events: a pattern of only
 * letters/digits/`_`/`|` is split on `|` for exact alternatives; otherwise it is
 * treated as a JavaScript RegExp tested anywhere in the tool name. Empty / `*`
 * matches everything.
 */
export function claudeMatcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    return matcher.split('|').includes(toolName)
  }
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return false
  }
}

/** One parsed Claude settings file: usable hooks plus per-entry authoring warnings. */
interface ParsedClaudeConfig {
  hooks: DiscoveredClaudeHook[]
  warnings: HookValidationWarning[]
}

/**
 * Parse one Claude `settings.json` for command hooks under `hooks.*`. Only the
 * wired events ({@link CLAUDE_WIRED_HOOK_EVENTS}) are honoured; non-command
 * handlers and malformed entries are skipped — a bad settings file must never
 * break the agent loop.
 *
 * G3 warn-level authoring lint (decision 8: "unknown events in a foreign file
 * are warned about, never silently skipped"): a hooks group under an event Copse
 * does not wire is skipped **with a warning** — distinguishing an event the
 * pinned Claude schema recognises (`schemas/vendor/…`) but Copse doesn't act on
 * yet, from an outright unknown event (likely a typo). This is a warn-only lint;
 * it never gates loading the valid hooks.
 */
async function parseClaudeSettings(path: string, scope: HookScope): Promise<ParsedClaudeConfig> {
  const warnings: HookValidationWarning[] = []
  const warn = (message: string, event?: string): void => {
    warnings.push({ source: path, scope, message, ...(event !== undefined ? { event } : {}) })
  }

  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf-8')
  } catch {
    // A missing settings file is the normal case, not an authoring problem.
    return { hooks: [], warnings }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn(`${claudeFileLabel(path)} is not valid JSON — file ignored`)
    return { hooks: [], warnings }
  }

  // parsed comes from JSON.parse and can legitimately be null; optional-chain.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hooksRoot = (parsed as { hooks?: unknown })?.hooks
  if (typeof hooksRoot !== 'object' || hooksRoot === null) return { hooks: [], warnings }

  const cwd = dirname(path)
  const out: DiscoveredClaudeHook[] = []
  for (const [event, groups] of Object.entries(hooksRoot as Record<string, unknown>)) {
    if (!(CLAUDE_WIRED_HOOK_EVENTS as readonly string[]).includes(event)) {
      // Only warn for keys that actually declare hook groups; ignore empties.
      if (Array.isArray(groups) && groups.length > 0) {
        if (isPublishedClaudeEvent(event)) {
          warn(
            `Claude hook event "${event}" is recognised by Claude Code but not supported by Copse yet — entries ignored`,
            event,
          )
        } else {
          warn(`Unknown Claude hook event "${event}" — entries ignored`, event)
        }
      }
      continue
    }
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue
      const matcherRaw = (group as { matcher?: unknown }).matcher
      const matcher =
        typeof matcherRaw === 'string' && matcherRaw.trim() ? matcherRaw.trim() : undefined
      const handlers = (group as { hooks?: unknown }).hooks
      if (!Array.isArray(handlers)) continue
      for (const handler of handlers) {
        if (typeof handler !== 'object' || handler === null) continue
        const type = (handler as { type?: unknown }).type
        // Default type in Claude docs is command; accept omitted type as command.
        if (type !== undefined && type !== 'command') continue
        const command = (handler as { command?: unknown }).command
        if (typeof command !== 'string' || !command.trim()) continue
        const timeoutMs = normalizeClaudeTimeout((handler as { timeout?: unknown }).timeout)
        const entry: DiscoveredClaudeHook = {
          event: event as DiscoveredClaudeEvent,
          command: command.trim(),
          cwd,
          source: path,
          scope,
        }
        if (matcher !== undefined) entry.matcher = matcher
        if (timeoutMs !== undefined) entry.timeoutMs = timeoutMs
        out.push(entry)
      }
    }
  }
  return { hooks: out, warnings }
}

/** A short label for a Claude settings file used in warning messages. */
function claudeFileLabel(path: string): string {
  return path.endsWith('settings.local.json')
    ? '.claude/settings.local.json'
    : '.claude/settings.json'
}

async function discoverClaudeHooksDetailed(opts: DialectDiscoverOpts): Promise<ParsedClaudeConfig> {
  const configs: Array<Promise<ParsedClaudeConfig>> = [
    parseClaudeSettings(userClaudeSettingsPath(), 'user'),
  ]
  if (opts.workspaceRoot && opts.projectTrusted) {
    configs.push(parseClaudeSettings(projectClaudeSettingsPath(opts.workspaceRoot), 'project'))
    configs.push(parseClaudeSettings(projectClaudeLocalSettingsPath(opts.workspaceRoot), 'project'))
  }
  const results = await Promise.all(configs)
  return {
    hooks: results.flatMap((r) => r.hooks),
    warnings: results.flatMap((r) => r.warnings),
  }
}

async function discoverClaudeHooks(opts: DialectDiscoverOpts): Promise<DiscoveredClaudeHook[]> {
  return (await discoverClaudeHooksDetailed(opts)).hooks
}

/** Diagnostics / Settings → Sources — discovered Claude hooks + authoring warnings. */
export async function listClaudeHooks(opts: DialectDiscoverOpts): Promise<HooksListResult> {
  const { hooks, warnings } = await discoverClaudeHooksDetailed(opts)
  const summaries = hooks.map((h) => {
    const summary: HookSummary = {
      family: 'claude',
      event: h.event,
      command: h.command,
      source: h.source,
      scope: h.scope,
      // `discoverClaudeHooks` returns only wired events (`PreToolUse` tool gate +
      // `SessionStart` fire-and-forget, H4), so every discovered Claude hook is
      // currently supported.
      supported: true,
    }
    if (h.matcher !== undefined) summary.matcher = h.matcher
    return summary
  })
  return { hooks: summaries, warnings }
}

/**
 * Project (repo-supplied) hook commands already audit-logged this session, so we warn
 * at most once per distinct command rather than on every gated tool call.
 */
const warnedProjectHookCommands = new Set<string>()

function auditProjectHook(hook: DiscoveredClaudeHook): void {
  if (hook.scope !== 'project') return
  if (warnedProjectHookCommands.has(hook.command)) return
  warnedProjectHookCommands.add(hook.command)
  console.warn(
    `[claude-hooks] executing project (repo-supplied) PreToolUse hook: ${hook.command} ` +
      `(from ${hook.source}). Project hooks run outside the sandbox with tool tokens in env; ` +
      `see docs/claude-hooks.md#security.`,
  )
}

// ---------------------------------------------------------------------------
// tool → Claude tool-name matcher + wire marshalling (both directions)
// ---------------------------------------------------------------------------

/** Map a canonical Copse tool call to the Claude PreToolUse tool_name + tool_input. */
export function claudeToolForTool(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; toolInput: Record<string, unknown> } | null {
  if (toolName === 'run_shell') {
    const command = input['command']
    return { toolName: 'Bash', toolInput: { command: typeof command === 'string' ? command : '' } }
  }
  if (toolName.startsWith('mcp__')) {
    return { toolName, toolInput: { ...input } }
  }
  if (toolName === 'read_file') {
    const path = input['path']
    return { toolName: 'Read', toolInput: { file_path: typeof path === 'string' ? path : '' } }
  }
  return null
}

/**
 * Discover the Claude PreToolUse command hooks that match `payload.toolName`, as
 * registry `CommandHook`s. Matching uses the Claude tool name (`Bash` / `Read` /
 * `mcp__…`) so a hook sees the vendor's tool vocabulary (decision 8). Claude has
 * no `failClosed`, so `onFailure` is always `open`.
 */
export async function claudeToolGateHooks(
  payload: HookEventPayloads['toolGate'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'toolGate'>[]> {
  const mapped = claudeToolForTool(payload.toolName, payload.input)
  if (!mapped) return []
  const hooks = await discoverClaudeHooks(opts)
  return hooks
    .filter((h) => claudeMatcherMatches(h.matcher, mapped.toolName))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'toolGate' as const,
        executor: 'command' as const,
        dialect: 'claude' as const,
        command: h.command,
        onFailure: 'open' as const,
        cwd: h.scope === 'project' ? (opts.executionRoot ?? h.cwd) : h.cwd,
        ...(opts.executionRoot ? { executionRoot: opts.executionRoot } : {}),
        timeoutMs: h.timeoutMs ?? CLAUDE_DEFAULT_HOOK_TIMEOUT_MS,
      }
    })
}

/**
 * Discover the Claude `SessionStart` command hooks (H4), as registry
 * `CommandHook`s. `SessionStart` carries no tool subject; its matcher is the
 * session *source* (`startup` / `resume` / `clear` / `compact`). Copse fires on
 * a new conversation, which maps to Claude's `startup` source, so a hook whose
 * matcher does not include `startup` (and is not the match-all `*` / omitted)
 * is skipped. Fired **detached** (fire-and-forget) by `session-start.ts`;
 * Claude has no `failClosed`, so `onFailure` is always `open`.
 */
export async function claudeSessionStartHooks(
  _payload: HookEventPayloads['sessionStart'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'sessionStart'>[]> {
  const hooks = await discoverClaudeHooks(opts)
  return hooks
    .filter((h) => h.event === 'SessionStart' && claudeMatcherMatches(h.matcher, 'startup'))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'sessionStart' as const,
        executor: 'command' as const,
        dialect: 'claude' as const,
        command: h.command,
        onFailure: 'open' as const,
        cwd: h.scope === 'project' ? (opts.executionRoot ?? h.cwd) : h.cwd,
        ...(opts.executionRoot ? { executionRoot: opts.executionRoot } : {}),
        timeoutMs: h.timeoutMs ?? CLAUDE_DEFAULT_HOOK_TIMEOUT_MS,
      }
    })
}

function mapClaudeDecision(decision: ClaudePermissionDecision): HookDecision {
  // `defer` ends a Claude Code query so it can resume later — Copse has no defer
  // path, so treat it as `ask` (surface / fall through to our gate).
  if (decision === 'defer') return 'ask'
  return decision
}

function spineDecisionFor(outcome: BlockingHookOutcome | null): SpineHookRunDecision {
  if (!outcome) return {}
  return {
    ...(outcome.decision !== undefined ? { permission: outcome.decision } : {}),
    ...(outcome.injectContext !== undefined
      ? { injectContextChars: outcome.injectContext.length }
      : {}),
    ...(outcome.agentMessage !== undefined
      ? { agentMessageChars: outcome.agentMessage.length }
      : {}),
  }
}

function denyOutcome(reason: string): BlockingHookOutcome {
  return reason ? { decision: 'deny', agentMessage: reason } : { decision: 'deny' }
}

/**
 * Interpret exit-0 stdout JSON: `continue: false` stops the run (treated as deny
 * for the gate), else `hookSpecificOutput.permissionDecision` is honoured.
 */
function outcomeFromExitZero(stdout: string): {
  outcome: BlockingHookOutcome | null
  parseOk: boolean
} {
  const text = stdout.trim()
  if (!text) return { outcome: null, parseOk: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { outcome: null, parseOk: false }
  }
  if (typeof parsed !== 'object' || parsed === null) return { outcome: null, parseOk: true }

  if ((parsed as { continue?: unknown }).continue === false) {
    const stopReason = (parsed as { stopReason?: unknown }).stopReason
    const reason = typeof stopReason === 'string' ? stopReason.trim() : ''
    return { outcome: denyOutcome(reason), parseOk: true }
  }

  const specific = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (typeof specific !== 'object' || specific === null) return { outcome: null, parseOk: true }

  const outcome: BlockingHookOutcome = {}

  const permissionRaw = (specific as { permissionDecision?: unknown }).permissionDecision
  if (isPermissionDecision(permissionRaw)) {
    outcome.decision = mapClaudeDecision(permissionRaw)
    const reasonRaw = (specific as { permissionDecisionReason?: unknown }).permissionDecisionReason
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : ''
    if (reason) outcome.agentMessage = reason
  }

  // H2: Claude's PreToolUse `hookSpecificOutput.additionalContext` injects text
  // into the current turn (vendor ✅). It rides alongside any permissionDecision
  // (a hook may allow *and* add context) and maps onto the canonical
  // `injectContext`, which the tool-gate fire site places into the turn as a
  // system-reminder block (10k-capped).
  const additionalRaw = (specific as { additionalContext?: unknown }).additionalContext
  if (typeof additionalRaw === 'string' && additionalRaw.length > 0) {
    outcome.injectContext = additionalRaw
  }

  return { outcome: Object.keys(outcome).length > 0 ? outcome : null, parseOk: true }
}

/** The concrete Claude dialect adapter the runner delegates to. */
export const claudeAdapter: DialectAdapter = {
  dialect: 'claude',

  // `_session` (B4 agent-session identity) is accepted for interface parity but
  // unused: Claude's PreToolUse contract has no conversation/generation/model
  // fields — Claude carries an optional `model` on `sessionStart` only (H4 fire
  // site), matching the vendor audit in docs/plans/hooks-and-feature-packs.md.
  marshalToolGateRequest(hook, payload, _session) {
    const mapped = claudeToolForTool(payload.toolName, payload.input)
    if (!mapped) return null
    return {
      session_id: '',
      transcript_path: '',
      cwd: hook.executionRoot ?? getAgentExecutionRoot() ?? '',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: mapped.toolName,
      tool_input: mapped.toolInput,
    }
  },

  interpretToolGate(spawn: HookSpawnResult): DialectInterpretation {
    const spineEvent = 'PreToolUse'

    // Exit 2 is Claude's blocking signal — a *decision*, not a failure. stderr
    // (falling back to stdout) is the deny reason surfaced to the agent.
    if (spawn.exitCode === 2) {
      const reason = spawn.stderr.trim() || spawn.stdout.trim()
      const outcome = denyOutcome(reason)
      return {
        outcome,
        failed: false,
        parseOk: true,
        spineEvent,
        spineDecision: spineDecisionFor(outcome),
      }
    }

    // Everything else that isn't a clean exit fails **open** (Claude has no
    // failClosed): crash, timeout, spawn error, or any other non-zero exit.
    if (spawn.spawnError || spawn.timedOut || spawn.exitCode !== 0) {
      return { outcome: null, failed: true, parseOk: false, spineEvent, spineDecision: {} }
    }

    const { outcome, parseOk } = outcomeFromExitZero(spawn.stdout)
    return { outcome, failed: false, parseOk, spineEvent, spineDecision: spineDecisionFor(outcome) }
  },

  marshalSessionStartRequest(hook, _payload, session) {
    // Claude's SessionStart stdin (vendor docs): `session_id`, `transcript_path`,
    // `cwd`, `hook_event_name`, and `source`. Copse fires on a new conversation,
    // which maps to the `startup` source. B4 readiness: SessionStart is the one
    // Claude agent-session event that carries an **optional `model`** (the
    // running model slug), added here only when the host resolved one — every
    // other Claude event omits it, matching the vendor contract.
    const req: Record<string, unknown> = {
      session_id: session?.conversationId ?? '',
      transcript_path: '',
      cwd: hook.executionRoot ?? getAgentExecutionRoot() ?? '',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }
    const model = session?.model?.model
    if (model) req['model'] = model
    return req
  },

  interpretSessionStart(spawn: HookSpawnResult): DialectInterpretation {
    // SessionStart is fire-and-forget (decision 3): no control-flow decision, so
    // the outcome is always null. Claude propagates session env by having the
    // hook append to the file named in `$CLAUDE_ENV_FILE` (not a JSON stdout
    // field), so no `sessionEnv` is parsed from stdout here — that file-based
    // path is deferred (see the H4 row in docs/plans/hooks-and-feature-packs.md).
    // A crash / timeout / non-zero exit is recorded `failed` for the spine only;
    // exit 2 is Claude's block signal but there is nothing to block once the
    // session has started, so it too is a recorded no-op. `additionalContext`
    // (async injected context) is not consumed in v1 (decision 11).
    const spineEvent = 'SessionStart'
    const emptyDecision: SpineHookRunDecision = {}
    const base = { outcome: null, spineEvent, spineDecision: emptyDecision }
    if (spawn.spawnError || spawn.timedOut) {
      return { ...base, failed: true, parseOk: false }
    }
    return { ...base, failed: false, parseOk: true }
  },

  // Claude hook error state is not surfaced in Sources today (parity with the
  // pre-A2 behavior); the hook_run spine record still captures every failure.
  recordRuntimeFailure() {
    /* no-op: Claude Sources rows do not carry a per-hook lastError */
  },
}
