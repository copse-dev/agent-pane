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
import type {
  AgentSessionInfo,
  HookEventName,
  HookEventPayloads,
} from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome, HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import type {
  DialectAdapter,
  DialectDiscoverOpts,
  DialectInterpretation,
} from './dialect-adapter.ts'
import { type HookSpawnResult } from './hook-spawn.ts'
import { isRecord } from '@shared/unknown-value.ts'

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
 * Claude hook events Copse discovers from settings — every event whose canonical
 * fire point exists today. `PreToolUse` (tool gate, A2/B4), `SessionStart` (H4 —
 * fire-and-forget session lifecycle, the only Claude agent-session event that
 * carries an optional `model`, per the vendor contract), plus the four that ride
 * fire points Cursor hooks were already using: `PostToolUse` → `afterToolUse`,
 * `UserPromptSubmit` → `beforeSubmitPrompt`, `Stop` → `stop`, and
 * `SubagentStop` → `subagentStop`.
 */
type DiscoveredClaudeEvent =
  'PreToolUse' | 'SessionStart' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SubagentStop'

/**
 * The Claude events Copse actually wires (discovers + fires). Every other event
 * the vendored SchemaStore schema publishes is intentionally-unsupported — the
 * G3 drift detector pins this set against
 * `schemas/vendor/claude-code-settings.schema.json`.
 */
export const CLAUDE_WIRED_HOOK_EVENTS: readonly DiscoveredClaudeEvent[] = [
  'PreToolUse',
  'SessionStart',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
]

function isDiscoveredClaudeEvent(value: string): value is DiscoveredClaudeEvent {
  return CLAUDE_WIRED_HOOK_EVENTS.some((event) => event === value)
}

/** A parsed Claude command hook ready to spawn. */
interface DiscoveredClaudeHook {
  event: DiscoveredClaudeEvent
  /**
   * Tool-name matcher for `PreToolUse` / `PostToolUse` (`Bash`, `Edit|Write`,
   * `mcp__.*`, `*`, or omitted = all). For `SessionStart` the matcher is the
   * session source (`startup` / `resume` / `clear` / `compact`); Copse fires on
   * new conversations, so a matcher-less SessionStart hook always applies.
   * `UserPromptSubmit` / `Stop` / `SubagentStop` carry no matcher subject in
   * Claude's contract — a matcher on them is ignored, as in Claude Code.
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

  const hooksRoot = isRecord(parsed) ? parsed['hooks'] : undefined
  if (!isRecord(hooksRoot)) return { hooks: [], warnings }

  const cwd = dirname(path)
  const out: DiscoveredClaudeHook[] = []
  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!isDiscoveredClaudeEvent(event)) {
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
      if (!isRecord(group)) continue
      const matcherRaw = group['matcher']
      const matcher =
        typeof matcherRaw === 'string' && matcherRaw.trim() ? matcherRaw.trim() : undefined
      const handlers = group['hooks']
      if (!Array.isArray(handlers)) continue
      for (const handler of handlers) {
        if (!isRecord(handler)) continue
        const type = handler['type']
        // Default type in Claude docs is command; accept omitted type as command.
        if (type !== undefined && type !== 'command') continue
        const command = handler['command']
        if (typeof command !== 'string' || !command.trim()) continue
        const timeoutMs = normalizeClaudeTimeout(handler['timeout'])
        const entry: DiscoveredClaudeHook = {
          event,
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
      // `discoverClaudeHooks` returns only wired events
      // ({@link CLAUDE_WIRED_HOOK_EVENTS}); anything else is skipped at parse
      // time with a warning, so every discovered Claude hook is supported.
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
    `[claude-hooks] executing project (repo-supplied) ${hook.event} hook: ${hook.command} ` +
      `(from ${hook.source}). Project hooks run outside the sandbox with tool tokens in env; ` +
      `see docs/claude-hooks.md#security.`,
  )
}

/**
 * Build the registry `CommandHook` for a discovered Claude hook on `event`.
 * Every Claude discovery function resolves the same way — Claude has no
 * `failClosed`, so `onFailure` is always `open` (decision 9); a project-scoped
 * hook runs in the thread checkout and is audit-logged once per command; the
 * per-hook `timeout` wins over the dialect default (decision 13 / H4).
 */
function toCommandHook<E extends HookEventName>(
  hook: DiscoveredClaudeHook,
  event: E,
  opts: DialectDiscoverOpts,
): CommandHook<E> {
  auditProjectHook(hook)
  return {
    id: hook.command,
    event,
    executor: 'command' as const,
    dialect: 'claude' as const,
    wireEvent: hook.event,
    command: hook.command,
    onFailure: 'open' as const,
    cwd: hook.scope === 'project' ? (opts.executionRoot ?? hook.cwd) : hook.cwd,
    ...(opts.executionRoot ? { executionRoot: opts.executionRoot } : {}),
    timeoutMs: hook.timeoutMs ?? CLAUDE_DEFAULT_HOOK_TIMEOUT_MS,
  }
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
    .filter((h) => h.event === 'PreToolUse' && claudeMatcherMatches(h.matcher, mapped.toolName))
    .map((h) => toCommandHook(h, 'toolGate', opts))
}

/**
 * Discover the Claude `PostToolUse` command hooks for a finished tool call, as
 * canonical `afterToolUse` `CommandHook`s. Matching uses the Claude tool name
 * (`Bash` / `Read` / `mcp__…`), the same vocabulary `PreToolUse` matches against,
 * so one matcher pattern covers a tool on both sides of the call.
 *
 * Fired **detached** (decision 3) by the fire site (`after-tool-use.ts`), which
 * means Claude's "block" response cannot un-run the tool. Its `reason` /
 * `additionalContext` are preserved through the one safe async channel — a
 * hook-originated queued message (decision 11) — exactly as Cursor's generic
 * `postToolUse` `additional_context` already is.
 */
export async function claudeAfterToolUseHooks(
  payload: HookEventPayloads['afterToolUse'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'afterToolUse'>[]> {
  const mapped = claudeToolForTool(payload.toolName, payload.input ?? {})
  if (!mapped) return []
  const hooks = await discoverClaudeHooks(opts)
  return hooks
    .filter((h) => h.event === 'PostToolUse' && claudeMatcherMatches(h.matcher, mapped.toolName))
    .map((h) => toCommandHook(h, 'afterToolUse', opts))
}

/**
 * Discover the Claude `UserPromptSubmit` command hooks, as canonical
 * `beforeSubmitPrompt` `CommandHook`s. Claude's contract gives this event no
 * matcher subject, so every declared hook applies. **Blocking**: a `block`
 * decision (or exit 2) halts the submit, matching Claude Code, where the prompt
 * is not processed and the reason is shown to the user.
 */
export async function claudeBeforeSubmitPromptHooks(
  _payload: HookEventPayloads['beforeSubmitPrompt'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'beforeSubmitPrompt'>[]> {
  const hooks = await discoverClaudeHooks(opts)
  return hooks
    .filter((h) => h.event === 'UserPromptSubmit')
    .map((h) => toCommandHook(h, 'beforeSubmitPrompt', opts))
}

/**
 * Discover the Claude `Stop` command hooks, as canonical `stop` `CommandHook`s.
 * No matcher subject in Claude's contract, so every declared hook applies. Fired
 * **detached** at turn end / abort (decision 3, no drain barrier), so Claude's
 * "block the stop and keep going" response cannot resume the finished turn; the
 * `reason` routes through the pending-message queue (decision 4) instead of a
 * bespoke continuation protocol.
 */
export async function claudeStopHooks(
  _payload: HookEventPayloads['stop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'stop'>[]> {
  const hooks = await discoverClaudeHooks(opts)
  return hooks.filter((h) => h.event === 'Stop').map((h) => toCommandHook(h, 'stop', opts))
}

/**
 * Discover the Claude `SubagentStop` command hooks, as canonical `subagentStop`
 * `CommandHook`s. No matcher subject in Claude's contract, so every declared
 * hook applies (unlike Cursor's, which matches on subagent type). Fired
 * **detached** on subagent completion; a block `reason` becomes a queued message
 * the same way Cursor's `followup_message` does (C2/C3).
 */
export async function claudeSubagentStopHooks(
  _payload: HookEventPayloads['subagentStop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'subagentStop'>[]> {
  const hooks = await discoverClaudeHooks(opts)
  return hooks
    .filter((h) => h.event === 'SubagentStop')
    .map((h) => toCommandHook(h, 'subagentStop', opts))
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
    .map((h) => toCommandHook(h, 'sessionStart', opts))
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

// ---------------------------------------------------------------------------
// The non-gate Claude events (PostToolUse / UserPromptSubmit / Stop /
// SubagentStop) — shared stdin base + shared response reading
// ---------------------------------------------------------------------------

/**
 * The stdin envelope every Claude hook event carries: the session identity, the
 * transcript path (Copse keeps no Claude-format transcript, so it is empty —
 * honest rather than a fabricated path a hook might try to read), the cwd, and
 * the event name. Per-event fields are spread on top by each marshaller.
 */
function claudeWireBase(
  hook: CommandHook,
  event: DiscoveredClaudeEvent,
  session?: AgentSessionInfo,
): Record<string, unknown> {
  return {
    session_id: session?.conversationId ?? '',
    transcript_path: '',
    cwd: hook.executionRoot ?? getAgentExecutionRoot() ?? '',
    hook_event_name: event,
  }
}

/**
 * Claude's *common* JSON output fields, shared by every event. `continue: false`
 * stops all processing (`stopReason` explains it); `decision: "block"` is the
 * per-event block signal (`reason` explains it, and for `Stop` / `SubagentStop`
 * is what the vendor shows the model). Only the string reason is extracted here
 * — what each event *does* with it is the per-event interpretation's business.
 */
function claudeBlockReason(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  if (parsed['continue'] === false) {
    const stopReason = parsed['stopReason']
    return typeof stopReason === 'string' && stopReason.trim() ? stopReason.trim() : ''
  }
  if (parsed['decision'] === 'block') {
    const reason = parsed['reason']
    return typeof reason === 'string' && reason.trim() ? reason.trim() : ''
  }
  return undefined
}

/**
 * Claude's `hookSpecificOutput.additionalContext` — context the hook wants added
 * to the model's view. Present on `UserPromptSubmit` and `PostToolUse`.
 */
function claudeAdditionalContext(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  const specific = parsed['hookSpecificOutput']
  if (!isRecord(specific)) return undefined
  const raw = specific['additionalContext']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * Read the stdout of a non-gate Claude hook. Empty stdout is an intentional
 * no-response; unparseable stdout is reported `parseOk: false` but, for an
 * observation event, is not something to fail the run over — nothing downstream
 * can be blocked by then.
 */
function parseClaudeStdout(stdout: string): { parsed: unknown; parseOk: boolean } {
  const text = stdout.trim()
  if (!text) return { parsed: null, parseOk: true }
  try {
    return { parsed: JSON.parse(text), parseOk: true }
  } catch {
    return { parsed: null, parseOk: false }
  }
}

/**
 * Build the async interpretation for a detached Claude observation event
 * (`PostToolUse` / `Stop` / `SubagentStop`). These three share one shape: the
 * event has already happened, so nothing they return can gate control flow
 * (`outcome` is always null) — but Claude's contract still gives them a way to
 * put text in front of the model, via exit 2's stderr, `decision: "block"`'s
 * `reason`, or `additionalContext`. Copse routes all three through the single
 * async output channel, a hook-originated queued message (decision 4 / 11),
 * rather than inventing a per-event continuation protocol it cannot honour.
 */
function claudeAsyncInterpretation(
  spawn: HookSpawnResult,
  spineEvent: DiscoveredClaudeEvent,
): DialectInterpretation {
  const emptyDecision: SpineHookRunDecision = {}
  const base = { outcome: null, spineEvent, spineDecision: emptyDecision }

  if (spawn.spawnError || spawn.timedOut) {
    return { ...base, failed: true, parseOk: false }
  }

  // Exit 2 is Claude's block signal; for these events it means "show the model
  // this stderr", not "undo what happened". Surfaced as a queued message.
  if (spawn.exitCode === 2) {
    const reason = spawn.stderr.trim()
    if (!reason) return { ...base, failed: false, parseOk: true }
    return {
      ...base,
      queueMessage: { text: reason, sendNow: false },
      spineDecision: { queuedMessageChars: reason.length },
      failed: false,
      parseOk: true,
    }
  }

  if (spawn.exitCode !== 0) {
    return { ...base, failed: true, parseOk: true }
  }

  const { parsed, parseOk } = parseClaudeStdout(spawn.stdout)
  if (!parseOk) return { ...base, failed: false, parseOk: false }

  // A block with an empty reason carries no text of its own, so fall through to
  // `additionalContext` rather than queueing an empty message.
  const blockReason = claudeBlockReason(parsed)
  const text =
    blockReason !== undefined && blockReason !== '' ? blockReason : claudeAdditionalContext(parsed)
  if (text === undefined || text === '') return { ...base, failed: false, parseOk: true }
  return {
    ...base,
    queueMessage: { text, sendNow: false },
    spineDecision: { queuedMessageChars: text.length },
    failed: false,
    parseOk: true,
  }
}

/** The concrete Claude dialect adapter the runner delegates to. */
export const claudeAdapter: DialectAdapter = {
  dialect: 'claude',

  // B4 agent-session identity: Claude's tool events carry `session_id` and
  // nothing else from the envelope — no generation id, and `model` rides
  // `SessionStart` alone, matching the vendor audit in
  // docs/plans/hooks-and-feature-packs.md. (`session_id` was previously hardcoded
  // empty here even when a session was running; it now comes from the session,
  // as it already did for `SessionStart` and now does for the other events.)
  marshalToolGateRequest(hook, payload, session) {
    const mapped = claudeToolForTool(payload.toolName, payload.input)
    if (!mapped) return null
    return {
      ...claudeWireBase(hook, 'PreToolUse', session),
      permission_mode: 'default',
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

  marshalAfterToolUseRequest(hook, payload, session) {
    // Claude's PostToolUse stdin: the PreToolUse fields plus `tool_response`.
    // Copse's normalized tool result is textual, so the response is that text —
    // no vendor-specific result object shape is invented for it.
    const mapped = claudeToolForTool(payload.toolName, payload.input ?? {})
    if (!mapped) return null
    return {
      ...claudeWireBase(hook, 'PostToolUse', session),
      permission_mode: 'default',
      tool_name: mapped.toolName,
      tool_input: mapped.toolInput,
      tool_response: payload.output ?? '',
    }
  },

  interpretAfterToolUse(spawn: HookSpawnResult): DialectInterpretation {
    return claudeAsyncInterpretation(spawn, 'PostToolUse')
  },

  marshalBeforeSubmitPromptRequest(hook, payload, session) {
    // Claude's UserPromptSubmit stdin: the envelope plus the prompt about to run.
    return { ...claudeWireBase(hook, 'UserPromptSubmit', session), prompt: payload.prompt }
  },

  interpretBeforeSubmitPrompt(spawn: HookSpawnResult): DialectInterpretation {
    // The one *blocking* event of the four: Claude does not process a blocked
    // prompt, which is exactly decision 12's `haltRun`. Exit 2 blocks with stderr
    // as the reason; on exit 0, `decision: "block"` (or `continue: false`) blocks
    // with its reason, and `additionalContext` is prepended to a prompt that
    // proceeds. Any other non-zero exit fails **open** (Claude has no failClosed).
    const spineEvent = 'UserPromptSubmit'
    const emptyDecision: SpineHookRunDecision = {}
    const base = { outcome: null, spineEvent, spineDecision: emptyDecision }

    if (spawn.spawnError || spawn.timedOut) {
      return { ...base, failed: true, parseOk: false }
    }

    if (spawn.exitCode === 2) {
      const reason =
        spawn.stderr.trim() || 'Prompt submission was blocked by a UserPromptSubmit hook.'
      return {
        ...base,
        outcome: { haltRun: { reason }, userMessage: reason },
        spineDecision: { haltRun: true, userMessageChars: reason.length },
        failed: false,
        parseOk: true,
      }
    }

    if (spawn.exitCode !== 0) {
      return { ...base, failed: true, parseOk: true }
    }

    const { parsed, parseOk } = parseClaudeStdout(spawn.stdout)
    if (!parseOk) {
      return { ...base, failed: true, parseOk: false }
    }

    const blockReason = claudeBlockReason(parsed)
    if (blockReason !== undefined) {
      const reason = blockReason || 'Prompt submission was blocked by a UserPromptSubmit hook.'
      return {
        ...base,
        outcome: { haltRun: { reason }, userMessage: reason },
        spineDecision: { haltRun: true, userMessageChars: reason.length },
        failed: false,
        parseOk: true,
      }
    }

    // Injected context only matters when the submit proceeds — a halt drops the
    // turn entirely, so there is nothing to inject into (mirrors the Cursor path).
    const injected = claudeAdditionalContext(parsed)
    if (injected !== undefined) {
      return {
        ...base,
        outcome: { injectContext: injected },
        spineDecision: { injectContextChars: injected.length },
        failed: false,
        parseOk: true,
      }
    }
    return { ...base, failed: false, parseOk: true }
  },

  marshalStopRequest(hook, _payload, session) {
    // Claude's Stop stdin: the envelope plus `stop_hook_active`, which Claude
    // sets when the agent is *already* continuing because of a Stop hook, so a
    // hook can avoid looping. Copse dispatches `stop` detached and never resumes
    // a finished turn from it, so that state can never be true here.
    return { ...claudeWireBase(hook, 'Stop', session), stop_hook_active: false }
  },

  interpretStop(spawn: HookSpawnResult): DialectInterpretation {
    return claudeAsyncInterpretation(spawn, 'Stop')
  },

  marshalSubagentStopRequest(hook, _payload, session) {
    // Claude's SubagentStop stdin mirrors Stop's. The canonical payload's
    // subagent type / status have no field in the vendor contract, so they are
    // not smuggled in under invented names.
    return { ...claudeWireBase(hook, 'SubagentStop', session), stop_hook_active: false }
  },

  interpretSubagentStop(spawn: HookSpawnResult): DialectInterpretation {
    return claudeAsyncInterpretation(spawn, 'SubagentStop')
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
