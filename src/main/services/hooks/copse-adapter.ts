// Copse dialect adapter (decision 8) — `.copse/hooks.json`, our **native** hook
// config format (F1).
//
// Owns everything Copse-specific: discovery of `~/.copse/hooks.json` and
// `<root>/.copse/hooks.json`, parsing the native field set (`async`,
// `onFailure`, `sandbox`, `loop_limit`, plus `timeout` / `matcher` / `glob`),
// per-event matchers, wire marshalling in both directions, the per-event
// exit-code / `onFailure` table, and unsupported-capability reporting. Because
// Copse is the native dialect it speaks the **canonical** event names and the
// **canonical decision vocabulary** directly — no vendor translation layer, so
// the wire shapes here are a thin envelope around the canonical payload /
// {@link BlockingHookOutcome}.
//
// Copse hooks fail **open by default** (`onFailure: open`) — a crash, timeout,
// or invalid JSON is treated as no-opinion so a broken hook never wedges the
// agent — with a per-hook `onFailure: closed` escape that **blocks** those same
// failures (decision 9, the same knob as Cursor `failClosed: true`). The adapter
// reports `failed` + the hook's `onFailure`; the shared runner turns that into
// deny/allow.
//
// **F2 — Copse-native events wired.** The four Copse-native events
// (`beforeDiffApply` blocking, `afterDiffApply` / `permissionDecision` /
// `postTurnReview` async observation) now have discovery + marshal/interpret
// here and are listed in {@link COPSE_SUPPORTED_EVENTS}; their host fire sites
// live in `diff-apply.ts` / `permission-decision.ts` / `post-turn-review.ts`.
// Cursor / Claude declare none of these (Copse-native), so only the Copse
// adapter marshals them. F3 landed the sandbox-by-default spawn reversal: the
// `sandbox` field carried here now drives the sandboxed spawn (`hook-spawn.ts`),
// the `sandbox: false` escape is surfaced on the Sources summary below, and a
// blocked-by-sandbox run is recorded + resolved via `onFailure` in the runner.
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import micromatch from 'micromatch'
import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  type AgentSessionInfo,
  type HookEventPayloads,
} from '@copse/agent/hooks/canonical-events.ts'
import type { CommandHook, CommandHookFailureMode } from '@copse/agent/hooks/command-executor.ts'
import type { BlockingHookOutcome, HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { HookScope, HooksListResult, HookSummary } from '@shared/types/hooks.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import type {
  DialectAdapter,
  DialectDiscoverOpts,
  DialectInterpretation,
} from './dialect-adapter.ts'
import { type HookSpawnResult } from './hook-spawn.ts'
import { expectRecord, expectStringArray, isRecord } from '@shared/unknown-value.ts'

/**
 * Copse's per-hook timeout default (decision 13; H4). Copse-native hooks are our
 * own scripts, so we adopt a generous default in the spirit of the vendor
 * defaults (Cursor 30s, Claude 600s) — 30s balances "survives a real hook"
 * against "does not hang the agent forever" and can be overridden per hook via
 * the `timeout` field (in **seconds**). Kept as a module variable so tests can
 * shorten it to exercise the timeout failure mode without a wall-clock wait.
 */
export const COPSE_DEFAULT_HOOK_TIMEOUT_MS = 30_000

/**
 * The canonical events the Copse dialect can currently **declare and fire** —
 * exactly the events with a wired fire site (A2/B/D/H4 + the F2 Copse-native
 * events). Copse also accepts declarations for the not-yet-wired canonical
 * events (first-party assembly events, `compaction`) but reports them
 * `supported: false` (decision 8: unknown events warned, known-but-unwired
 * badged unsupported). The published JSON schema enumerates this exact set.
 */
export const COPSE_SUPPORTED_EVENTS: readonly HookEventName[] = [
  'toolGate',
  'beforeSubmitPrompt',
  'afterFileEdit',
  'stop',
  'subagentStart',
  'subagentStop',
  'afterToolUse',
  'sessionStart',
  // F2 Copse-native events.
  'beforeDiffApply',
  'afterDiffApply',
  'permissionDecision',
  'postTurnReview',
]

/** Whether Copse currently wires a fire site for `event` (else: badge unsupported). */
export function isCopseSupportedEvent(event: HookEventName): boolean {
  return COPSE_SUPPORTED_EVENTS.includes(event)
}

/**
 * Canonical events whose dispatch is fixed to **blocking decision** — a hook on
 * these can never opt into async (decision 2: only `asyncOptIn` events may).
 * Used to warn when a Copse hook sets `async: true` on one of them.
 */
const FIXED_BLOCKING_DECISION_EVENTS: readonly HookEventName[] = [
  'toolGate',
  'beforeSubmitPrompt',
  'subagentStart',
  'beforeDiffApply',
]

/** A parsed Copse hook command together with the config that declared it. */
interface DiscoveredCopseHook {
  event: HookEventName
  command: string
  /** Directory of the declaring `hooks.json`; relative commands resolve against it. */
  cwd: string
  source: string
  scope: HookScope
  /** `onFailure` (decision 9): `closed` blocks on failure, `open` (default) abstains. */
  onFailure: CommandHookFailureMode
  /**
   * Sandbox-by-default escape (decision 7). `true` (default) = sandboxed; `false`
   * = the `sandbox: false` escape. F1 parses / carries only; F3 enforces.
   */
  sandbox: boolean
  /**
   * Detached-async opt-in (decision 2). Honoured only on the `asyncOptIn` event
   * `afterFileEdit`; `true` on a fixed-blocking decision event
   * ({@link FIXED_BLOCKING_DECISION_EVENTS}) is invalid and warned about (then ignored).
   */
  async: boolean
  /**
   * Per-script `loop_limit` (decision 5), tighten-only. A non-negative integer
   * bound, or `null` (unlimited — clamped to the global budget with a warning).
   * Absent = no per-script tightener. F1 parses / carries only.
   */
  loopLimit?: number | null
  /** Per-hook `timeout` override in **milliseconds** (from the `timeout` seconds field). */
  timeoutMs?: number
  /**
   * Optional per-hook `matcher` regex (string). The field it tests against is
   * selected per event ({@link copseMatcherSubject}): the canonical tool name
   * for `toolGate` / `afterToolUse`, the subagent type for `subagentStart` /
   * `subagentStop`. Absent fires for every action; a malformed regex skips the
   * hook (skip-and-warn — a broken matcher must never accidentally gate
   * everything).
   */
  matcher?: string
  /**
   * Optional path glob(s) for `afterFileEdit` — the hook fires only for edited
   * paths matching one of the globs. Absent fires for every edit. From a string
   * or string[] `glob` field.
   */
  glob?: string[]
}

/** `~/.copse/hooks.json` — always trusted (the user installed it). */
export function userCopseHooksConfigPath(): string {
  return join(homedir(), '.copse', 'hooks.json')
}

/** `<root>/.copse/hooks.json` — only honoured when the workspace is trusted. */
export function projectCopseHooksConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.copse', 'hooks.json')
}

function isCanonicalEvent(value: string): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(value)
}

/**
 * Normalize an entry's `glob` matcher field to a clean string[] or undefined.
 * Accepts a single string or an array of strings; anything else (or an empty
 * result) yields undefined so the hook fires for every edit.
 */
function normalizeGlobField(value: unknown): string[] | undefined {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const globs = raw.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
  return globs.length > 0 ? globs : undefined
}

/**
 * Normalize a hook entry's `timeout` field to milliseconds. Copse's wire unit is
 * **seconds** (a number), so a valid positive, finite value is multiplied by
 * 1000. Anything else (missing, non-number, ≤ 0, NaN) yields undefined so the
 * hook falls back to the dialect default.
 */
function normalizeTimeoutField(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * 1000)
}

/** One parsed config: usable hooks plus per-entry authoring warnings. */
interface ParsedCopseConfig {
  hooks: DiscoveredCopseHook[]
  warnings: CopseHookValidationWarning[]
}

/** A malformed / unsupported `.copse/hooks.json` entry, surfaced as a warning row. */
interface CopseHookValidationWarning {
  event?: string
  message: string
  source: string
  scope: HookScope
}

/**
 * Parse one `.copse/hooks.json`. The shape is
 * `{ version, hooks: { <canonicalEvent>: [{ command, ... }] } }`. Malformed
 * entries and unknown events are skipped (a bad hook config must never break the
 * agent loop) but each skip is surfaced as a warn-level validation warning
 * (G3: a warn-level lint, never a load gate). Known-but-unwired canonical events
 * (F2-native, assembly) are kept and badged `supported: false` by the listing.
 */
async function parseCopseConfig(path: string, scope: HookScope): Promise<ParsedCopseConfig> {
  const warnings: CopseHookValidationWarning[] = []
  const warn = (message: string, event?: string): void => {
    warnings.push({ source: path, scope, message, ...(event !== undefined ? { event } : {}) })
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
    warn('.copse/hooks.json is not valid JSON — file ignored')
    return { hooks: [], warnings }
  }

  const hooks = isRecord(parsed) ? parsed['hooks'] : undefined
  if (!isRecord(hooks)) {
    warn('.copse/hooks.json has no "hooks" object — file ignored')
    return { hooks: [], warnings }
  }

  const cwd = dirname(path)
  const out: DiscoveredCopseHook[] = []
  for (const [event, entries] of Object.entries(hooks)) {
    if (!isCanonicalEvent(event)) {
      warn(`Unknown hook event "${event}" — entries skipped`, event)
      continue
    }
    if (!Array.isArray(entries)) {
      warn(`"${event}" must be an array of { command } entries — skipped`, event)
      continue
    }
    entries.forEach((entry, index) => {
      const parsedHook = parseCopseEntry(event, entry, index, cwd, path, scope, warn)
      if (parsedHook) out.push(parsedHook)
    })
  }
  return { hooks: out, warnings }
}

/** Parse + validate one hook entry, warning on every skipped / clamped field. */
function parseCopseEntry(
  event: HookEventName,
  entry: unknown,
  index: number,
  cwd: string,
  source: string,
  scope: HookScope,
  warn: (message: string, event?: string) => void,
): DiscoveredCopseHook | null {
  const position = `"${event}" entry ${String(index + 1)}`
  if (!isRecord(entry)) {
    warn(`${position} has a missing or empty "command" — skipped`, event)
    return null
  }
  const command = entry['command']
  if (typeof command !== 'string' || !command.trim()) {
    warn(`${position} has a missing or empty "command" — skipped`, event)
    return null
  }

  // onFailure — default open (fail-open), `closed` blocks on failure (decision 9).
  const onFailureRaw = entry['onFailure']
  let onFailure: CommandHookFailureMode = 'open'
  if (onFailureRaw === 'closed' || onFailureRaw === 'open') onFailure = onFailureRaw
  else if (onFailureRaw !== undefined)
    warn(`${position} "onFailure" must be "open" or "closed" — defaulting to "open"`, event)

  // sandbox — default true (sandbox-by-default, decision 7); `false` is the escape.
  const sandboxRaw = entry['sandbox']
  let sandbox = true
  if (typeof sandboxRaw === 'boolean') sandbox = sandboxRaw
  else if (sandboxRaw !== undefined)
    warn(`${position} "sandbox" must be a boolean — defaulting to sandboxed (true)`, event)

  // async — opt-in detached dispatch, honoured only on asyncOptIn events (decision 2).
  const asyncRaw = entry['async']
  let async = false
  if (typeof asyncRaw === 'boolean') async = asyncRaw
  else if (asyncRaw !== undefined) warn(`${position} "async" must be a boolean — ignored`, event)
  if (async && FIXED_BLOCKING_DECISION_EVENTS.includes(event)) {
    warn(
      `${position} "async: true" is not allowed on the blocking decision event "${event}" — ignored`,
      event,
    )
    async = false
  }

  // loop_limit — tighten-only (decision 5). A non-negative integer, or null
  // (unlimited → clamped to the global budget with a warning).
  const loopLimitRaw = entry['loop_limit']
  let loopLimit: number | null | undefined
  if (loopLimitRaw === null) {
    loopLimit = null
    warn(
      `${position} "loop_limit: null" (unlimited) has no effect: only the global auto-continuation budget applies (per-script enforcement pending, plan row C5) — human-in-the-loop is the floor`,
      event,
    )
  } else if (typeof loopLimitRaw === 'number') {
    if (Number.isInteger(loopLimitRaw) && loopLimitRaw >= 0) loopLimit = loopLimitRaw
    else warn(`${position} "loop_limit" must be a non-negative integer or null — ignored`, event)
  } else if (loopLimitRaw !== undefined) {
    warn(`${position} "loop_limit" must be a non-negative integer or null — ignored`, event)
  }

  const timeoutMs = normalizeTimeoutField(entry['timeout'])
  const glob = normalizeGlobField(entry['glob'])
  const matcherRaw = entry['matcher']
  const matcher =
    typeof matcherRaw === 'string' && matcherRaw.trim().length > 0 ? matcherRaw.trim() : undefined

  if (!isCopseSupportedEvent(event)) {
    warn(
      `"${event}" is a known canonical event with no wired fire site yet — declared hook parsed but inactive`,
      event,
    )
  }

  return {
    event,
    command: command.trim(),
    cwd,
    source,
    scope,
    onFailure,
    sandbox,
    async,
    ...(loopLimit !== undefined ? { loopLimit } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(matcher ? { matcher } : {}),
    ...(glob ? { glob } : {}),
  }
}

/** One project hook that opted out of the sandbox (decision 7 / F3). */
export interface UnsandboxedProjectHook {
  event: string
  command: string
}

/**
 * List the project's `.copse/hooks.json` entries that declare `sandbox: false`
 * — **independent of workspace trust** (decision 7 / F3). This is read-only
 * display parsing for the workspace-trust prompt: the user must see, *at the
 * consent moment*, that trusting this workspace will let these repo-supplied
 * scripts run outside the project sandbox. Nothing here spawns or registers a
 * hook; discovery for execution stays trust-gated in
 * {@link discoverCopseHooksDetailed}.
 */
export async function listUnsandboxedProjectHooks(
  workspaceRoot: string,
): Promise<UnsandboxedProjectHook[]> {
  const parsed = await parseCopseConfig(projectCopseHooksConfigPath(workspaceRoot), 'project')
  return parsed.hooks.filter((h) => !h.sandbox).map((h) => ({ event: h.event, command: h.command }))
}

/**
 * Discover all Copse hooks visible in the current context, with warnings.
 *
 * - User hooks (`~/.copse/hooks.json`) are always discovered.
 * - Project hooks (`<root>/.copse/hooks.json`) are only discovered when the
 *   workspace is trusted, because honouring them spawns scripts from a
 *   possibly-cloned repo.
 */
async function discoverCopseHooksDetailed(opts: DialectDiscoverOpts): Promise<ParsedCopseConfig> {
  const configs: Array<Promise<ParsedCopseConfig>> = [
    parseCopseConfig(userCopseHooksConfigPath(), 'user'),
  ]
  if (opts.workspaceRoot && opts.projectTrusted) {
    configs.push(parseCopseConfig(projectCopseHooksConfigPath(opts.workspaceRoot), 'project'))
  }
  const results = await Promise.all(configs)
  return {
    hooks: results.flatMap((r) => r.hooks),
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * Runtime hook failures observed this session, keyed by command+event and
 * recording only the *first* failure per hook. Feeds the per-hook error
 * indicator in Sources; never affects fail-open / `onFailure` semantics.
 */
const sessionHookErrors = new Map<string, string>()

function hookErrorKey(event: string, command: string): string {
  return `${event}\u0000${command}`
}

/** Test-only: clear the per-session hook error state between cases. */
export function resetCopseHookSessionErrorsForTest(): void {
  sessionHookErrors.clear()
}

/**
 * Per-hook timeout applied to discovered Copse hooks (decision 13). Kept as a
 * module variable so tests can shorten it to exercise the timeout failure mode
 * without a wall-clock wait; a per-hook `timeout` still wins over it.
 */
let copseHookTimeoutMs = COPSE_DEFAULT_HOOK_TIMEOUT_MS

/** Test-only: override the Copse per-hook timeout, or reset to the default when omitted. */
export function setCopseHookTimeoutForTest(ms?: number): void {
  copseHookTimeoutMs = ms ?? COPSE_DEFAULT_HOOK_TIMEOUT_MS
}

/** Diagnostics / Settings → Sources — discovered Copse hooks, regardless of enablement. */
export async function listCopseHooksForSources(
  opts: DialectDiscoverOpts,
): Promise<HooksListResult> {
  const { hooks, warnings } = await discoverCopseHooksDetailed(opts)
  const summaries: HookSummary[] = hooks.map((h) => {
    const lastError = sessionHookErrors.get(hookErrorKey(h.event, h.command))
    return {
      family: 'copse',
      event: h.event,
      command: h.command,
      source: h.source,
      scope: h.scope,
      supported: isCopseSupportedEvent(h.event),
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      // Surface the `sandbox: false` escape (decision 7 / F3) so Sources can
      // badge "outside sandbox" and the risk is visible. Only present when the
      // hook opted out; sandboxed-by-default hooks omit it.
      ...(h.sandbox ? {} : { sandbox: false }),
    }
  })
  return {
    hooks: summaries,
    warnings: warnings.map((w) => ({
      message: w.message,
      source: w.source,
      scope: w.scope,
      ...(w.event !== undefined ? { event: w.event } : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// matcher (per-event subject) + shared CommandHook mapping
// ---------------------------------------------------------------------------

/**
 * Auditing (decision 7): a project (repo-supplied) Copse hook runs a spawned
 * script; warn at most once per distinct command. When a hook sets the
 * `sandbox: false` escape, call that out — F3 enforces sandbox-by-default
 * (macOS), and the escape is what Sources badges "outside sandbox".
 */
const warnedProjectHookCommands = new Set<string>()

function auditProjectHook(hook: DiscoveredCopseHook): void {
  if (hook.scope !== 'project') return
  if (warnedProjectHookCommands.has(hook.command)) return
  warnedProjectHookCommands.add(hook.command)
  const sandboxNote = hook.sandbox
    ? 'sandboxed by default (F3 enforcement, macOS-only)'
    : 'declares sandbox:false — requests running OUTSIDE the sandbox'
  console.warn(
    `[copse-hooks] executing project (repo-supplied) hook for "${hook.event}": ${hook.command} ` +
      `(from ${hook.source}). ${sandboxNote}; see docs/copse-hooks.md#security.`,
  )
}

/**
 * Whether a hook's `matcher` regex covers `subject` — the field the matcher
 * tests against is selected per event by the caller (canonical tool name for
 * `toolGate` / `afterToolUse`, subagent type for the subagent events). Absent
 * matcher fires for every action; a malformed regex skips the hook
 * (skip-and-warn), consistent with the Cursor adapter's D3 matcher.
 */
function copseMatcherMatches(hook: DiscoveredCopseHook, subject: string): boolean {
  if (!hook.matcher) return true
  try {
    return new RegExp(hook.matcher).test(subject)
  } catch {
    console.warn(`[copse-hooks] invalid "${hook.event}" matcher /${hook.matcher}/ — hook skipped`)
    return false
  }
}

/** Whether an `afterFileEdit` hook's glob(s) cover the edited path (mirrors Cursor). */
function afterFileEditMatches(
  hook: DiscoveredCopseHook,
  filePath: string,
  workspaceRoot: string | null,
): boolean {
  if (!hook.glob || hook.glob.length === 0) return true
  const candidates = [filePath.replace(/\\/g, '/')]
  if (workspaceRoot) {
    const rel = relative(workspaceRoot, filePath).replace(/\\/g, '/')
    if (rel && !rel.startsWith('..')) candidates.push(rel)
  }
  return candidates.some(
    (c) =>
      micromatch.isMatch(c, expectStringArray(hook.glob), { dot: true }) ||
      micromatch.isMatch(c, expectStringArray(hook.glob), { dot: true, basename: true }),
  )
}

/** Map a discovered Copse hook to the shared {@link CommandHook} the registry stores. */
function toCommandHook<E extends HookEventName>(
  hook: DiscoveredCopseHook,
  event: E,
  executionRoot?: string | null,
): CommandHook<E> {
  return {
    id: hook.command,
    event,
    executor: 'command',
    dialect: 'copse',
    command: hook.command,
    onFailure: hook.onFailure,
    cwd: hook.scope === 'project' ? (executionRoot ?? hook.cwd) : hook.cwd,
    ...(executionRoot ? { executionRoot } : {}),
    sandbox: hook.sandbox,
    async: hook.async,
    timeoutMs: hook.timeoutMs ?? copseHookTimeoutMs,
    ...(hook.loopLimit !== undefined ? { loopLimit: hook.loopLimit } : {}),
  }
}

// ---------------------------------------------------------------------------
// Discovery functions (one per wired canonical event), mirroring the Cursor
// adapter so the fire sites concatenate `copse*Hooks` alongside `cursor*Hooks`.
// ---------------------------------------------------------------------------

export async function copseToolGateHooks(
  payload: HookEventPayloads['toolGate'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'toolGate'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'toolGate' && copseMatcherMatches(h, payload.toolName))
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'toolGate', opts.executionRoot)
    })
}

export async function copseBeforeSubmitPromptHooks(
  _payload: HookEventPayloads['beforeSubmitPrompt'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'beforeSubmitPrompt'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'beforeSubmitPrompt')
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'beforeSubmitPrompt', opts.executionRoot)
    })
}

/**
 * Discover the Copse `afterFileEdit` hooks whose glob covers `payload.filePath`,
 * **partitioned by dispatch** (decision 2): `blocking` hooks are awaited by the
 * fire site (formatters), `async` hooks (declared `async: true`) are dispatched
 * detached through the C1 executor. F1 + C1 wire the async opt-in.
 */
export async function copseAfterFileEditHooks(
  payload: HookEventPayloads['afterFileEdit'],
  opts: DialectDiscoverOpts,
): Promise<{
  blocking: CommandHook<'afterFileEdit'>[]
  async: CommandHook<'afterFileEdit'>[]
}> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  const matched = hooks.filter(
    (h) =>
      h.event === 'afterFileEdit' &&
      afterFileEditMatches(h, payload.filePath, opts.executionRoot ?? opts.workspaceRoot),
  )
  const blocking: CommandHook<'afterFileEdit'>[] = []
  const asyncHooks: CommandHook<'afterFileEdit'>[] = []
  for (const h of matched) {
    auditProjectHook(h)
    const cmd = toCommandHook(h, 'afterFileEdit', opts.executionRoot)
    if (h.async) asyncHooks.push(cmd)
    else blocking.push(cmd)
  }
  return { blocking, async: asyncHooks }
}

export async function copseStopHooks(
  _payload: HookEventPayloads['stop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'stop'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'stop')
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'stop', opts.executionRoot)
    })
}

export async function copseSubagentStartHooks(
  payload: HookEventPayloads['subagentStart'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'subagentStart'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'subagentStart' && copseMatcherMatches(h, payload.subagentType))
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'subagentStart', opts.executionRoot)
    })
}

export async function copseSubagentStopHooks(
  payload: HookEventPayloads['subagentStop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'subagentStop'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'subagentStop' && copseMatcherMatches(h, payload.subagentType))
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'subagentStop', opts.executionRoot)
    })
}

export async function copseAfterToolUseHooks(
  payload: HookEventPayloads['afterToolUse'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'afterToolUse'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'afterToolUse' && copseMatcherMatches(h, payload.toolName))
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'afterToolUse', opts.executionRoot)
    })
}

export async function copseSessionStartHooks(
  _payload: HookEventPayloads['sessionStart'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'sessionStart'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'sessionStart')
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'sessionStart', opts.executionRoot)
    })
}

/**
 * Discover the Copse `beforeDiffApply` hooks whose glob covers the diff's path
 * (F2, Copse-native). Blocking decision — a hook may deny / halt before a queued
 * (or direct) diff lands; the fire site reduces the outcomes like the tool gate.
 * Reuses the `afterFileEdit` glob matcher (the payload is a file path).
 */
export async function copseBeforeDiffApplyHooks(
  payload: HookEventPayloads['beforeDiffApply'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'beforeDiffApply'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter(
      (h) =>
        h.event === 'beforeDiffApply' &&
        afterFileEditMatches(h, payload.filePath, opts.executionRoot ?? opts.workspaceRoot),
    )
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'beforeDiffApply', opts.executionRoot)
    })
}

/**
 * Discover the Copse `afterDiffApply` hooks whose glob covers the diff's path
 * (F2, Copse-native). Async observation — dispatched detached; a `queueMessage`
 * follow-up routes through the pending-message queue (decision 4).
 */
export async function copseAfterDiffApplyHooks(
  payload: HookEventPayloads['afterDiffApply'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'afterDiffApply'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter(
      (h) =>
        h.event === 'afterDiffApply' &&
        afterFileEditMatches(h, payload.filePath, opts.executionRoot ?? opts.workspaceRoot),
    )
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'afterDiffApply', opts.executionRoot)
    })
}

/**
 * Discover the Copse `permissionDecision` hooks whose matcher covers the gated
 * tool name (F2, Copse-native). Async observation — a clean post-verdict
 * notification an audit logger (#840) can consume; it can never change the
 * verdict that already happened.
 */
export async function copsePermissionDecisionHooks(
  payload: HookEventPayloads['permissionDecision'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'permissionDecision'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'permissionDecision' && copseMatcherMatches(h, payload.toolName))
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'permissionDecision', opts.executionRoot)
    })
}

/**
 * Discover the Copse `postTurnReview` hooks (F2, Copse-native). Async
 * observation fired after a post-turn review verdict; no matcher subject (the
 * event is turn-scoped, not tool/subagent-scoped), so a declared matcher is
 * ignored and every hook fires.
 */
export async function copsePostTurnReviewHooks(
  _payload: HookEventPayloads['postTurnReview'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'postTurnReview'>[]> {
  const { hooks } = await discoverCopseHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'postTurnReview')
    .map((h) => {
      auditProjectHook(h)
      return toCommandHook(h, 'postTurnReview', opts.executionRoot)
    })
}

// ---------------------------------------------------------------------------
// wire marshalling (both directions)
//
// Copse is the native dialect, so stdin is the canonical payload under a small
// envelope, and stdout is the canonical decision vocabulary verbatim.
// ---------------------------------------------------------------------------

/** The base envelope every Copse hook payload carries (conversation/model/roots). */
function copseEnvelope(
  event: HookEventName,
  session: AgentSessionInfo | undefined,
  executionRoot?: string,
): Record<string, unknown> {
  const root = executionRoot ?? getAgentExecutionRoot()
  const base: Record<string, unknown> = {
    hook_event_name: event,
    conversation_id: session?.conversationId ?? '',
    generation_id: session?.generationId ?? '',
    workspace_roots: root ? [root] : [],
  }
  if (session?.model) {
    base['model'] = {
      model: session.model.model,
      model_id: session.model.modelId,
      model_params: session.model.modelParams,
    }
  }
  return base
}

function isHookDecision(value: unknown): value is HookDecision {
  return value === 'allow' || value === 'deny' || value === 'ask'
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** A tool-input rewrite is only valid as a plain object (arrays/scalars ignored). */
function asInputRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? expectRecord(value)
    : null
}

/**
 * The Copse response shape: the canonical decision vocabulary spoken directly.
 * `continue: false` is accepted as an alias for `haltRun` (parity with the other
 * dialects' `continue` field).
 */
interface CopseHookResponse {
  decision?: unknown
  haltRun?: { reason?: unknown }
  continue?: unknown
  updatedInput?: unknown
  injectContext?: unknown
  agentMessage?: unknown
  userMessage?: unknown
  queueMessage?: { text?: unknown; sendNow?: unknown }
  sessionEnv?: unknown
}

/** Parse a Copse `haltRun` / `continue: false` into a canonical halt, if present. */
function parseHaltRun(res: CopseHookResponse): { reason: string } | undefined {
  if (res.haltRun && typeof res.haltRun === 'object') {
    const reason = typeof res.haltRun.reason === 'string' ? res.haltRun.reason : 'Halted by hook'
    return { reason }
  }
  if (res.continue === false) {
    const reason = firstString(res.userMessage, res.agentMessage) ?? 'Halted by hook'
    return { reason }
  }
  return undefined
}

/** Parse the full canonical blocking outcome from a Copse response object. */
function copseBlockingOutcome(parsed: unknown): {
  outcome: BlockingHookOutcome | null
  spineDecision: SpineHookRunDecision
} {
  if (typeof parsed !== 'object' || parsed === null) return { outcome: null, spineDecision: {} }
  const res = parsed as CopseHookResponse
  const outcome: BlockingHookOutcome = {}

  const halt = parseHaltRun(res)
  if (halt) outcome.haltRun = halt
  if (isHookDecision(res.decision)) outcome.decision = res.decision
  const rewrite = asInputRecord(res.updatedInput)
  if (rewrite) outcome.updatedInput = rewrite
  const injected = typeof res.injectContext === 'string' ? res.injectContext : undefined
  if (injected !== undefined) outcome.injectContext = injected
  const agentMessage = firstString(res.agentMessage)
  if (agentMessage !== undefined) outcome.agentMessage = agentMessage
  const userMessage = firstString(res.userMessage)
  if (userMessage !== undefined) outcome.userMessage = userMessage

  const spineDecision: SpineHookRunDecision = {
    ...(outcome.decision !== undefined ? { permission: outcome.decision } : {}),
    ...(outcome.haltRun !== undefined ? { haltRun: true } : {}),
    ...(outcome.updatedInput !== undefined ? { updatedInput: true } : {}),
    ...(outcome.injectContext !== undefined
      ? { injectContextChars: outcome.injectContext.length }
      : {}),
    ...(outcome.agentMessage !== undefined
      ? { agentMessageChars: outcome.agentMessage.length }
      : {}),
    ...(outcome.userMessage !== undefined ? { userMessageChars: outcome.userMessage.length } : {}),
  }
  return { outcome: Object.keys(outcome).length > 0 ? outcome : null, spineDecision }
}

/** Parse an async `queueMessage` follow-up from a Copse response, if present. */
function copseQueueMessage(parsed: unknown): { text: string; sendNow: boolean } | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const qm = (parsed as CopseHookResponse).queueMessage
  if (!qm || typeof qm !== 'object') return undefined
  const text = typeof qm.text === 'string' ? qm.text : undefined
  if (text === undefined || text.length === 0) return undefined
  return { text, sendNow: qm.sendNow === true }
}

/** Parse a session-env overlay (string→string) from a Copse response, if present. */
function copseSessionEnv(parsed: unknown): Record<string, string> | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as CopseHookResponse).sessionEnv
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(expectRecord(raw))) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Shared spawn-result → interpretation prelude: handle spawn error, timeout,
 * empty stdout, and JSON parse. Returns either a terminal interpretation (in
 * `done`) or the successfully-parsed stdout object (in `parsed`).
 */
function interpretPrelude(
  spawn: HookSpawnResult,
  spineEvent: HookEventName,
): { done: DialectInterpretation } | { parsed: unknown } {
  const base: { outcome: null; spineEvent: HookEventName; spineDecision: SpineHookRunDecision } = {
    outcome: null,
    spineEvent,
    spineDecision: {},
  }
  if (spawn.spawnError) {
    return { done: { ...base, failed: true, parseOk: false, runtimeError: 'failed to start' } }
  }
  if (spawn.timedOut) {
    return {
      done: {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: `timed out after ${String(copseHookTimeoutMs / 1000)}s`,
      },
    }
  }
  const text = spawn.stdout.trim()
  if (!text) {
    if (spawn.exitCode === 0) return { done: { ...base, failed: false, parseOk: true } }
    const detail =
      spawn.exitCode === null ? 'was killed' : `exited with code ${String(spawn.exitCode)}`
    return { done: { ...base, failed: true, parseOk: true, runtimeError: detail } }
  }
  try {
    return { parsed: JSON.parse(text) }
  } catch {
    return {
      done: {
        ...base,
        failed: true,
        parseOk: false,
        runtimeError: 'printed invalid JSON — response ignored',
      },
    }
  }
}

/** The concrete Copse dialect adapter the runner delegates to. */
export const copseAdapter: DialectAdapter = {
  dialect: 'copse',

  marshalToolGateRequest(hook, payload, session) {
    return {
      ...copseEnvelope('toolGate', session, hook.executionRoot),
      tool_name: payload.toolName,
      input: payload.input,
      ...(payload.fileContent !== undefined ? { file_content: payload.fileContent } : {}),
    }
  },

  interpretToolGate(spawn, _payload) {
    const pre = interpretPrelude(spawn, 'toolGate')
    if ('done' in pre) return pre.done
    const { outcome, spineDecision } = copseBlockingOutcome(pre.parsed)
    return { outcome, spineEvent: 'toolGate', spineDecision, failed: false, parseOk: true }
  },

  marshalBeforeSubmitPromptRequest(hook, payload, session) {
    return {
      ...copseEnvelope('beforeSubmitPrompt', session, hook.executionRoot),
      prompt: payload.prompt,
    }
  },

  interpretBeforeSubmitPrompt(spawn, _payload) {
    const pre = interpretPrelude(spawn, 'beforeSubmitPrompt')
    if ('done' in pre) return pre.done
    const { outcome, spineDecision } = copseBlockingOutcome(pre.parsed)
    // A submit-halt drops the turn, so injected context has nothing to land in.
    if (outcome?.haltRun !== undefined && outcome.injectContext !== undefined) {
      delete outcome.injectContext
    }
    return {
      outcome,
      spineEvent: 'beforeSubmitPrompt',
      spineDecision,
      failed: false,
      parseOk: true,
    }
  },

  marshalAfterFileEditRequest(hook, payload, session) {
    return {
      ...copseEnvelope('afterFileEdit', session, hook.executionRoot),
      file_path: payload.filePath,
    }
  },

  interpretAfterFileEdit(spawn, _payload) {
    // afterFileEdit is a formatter/observer: blocking runs are notification-only
    // (the write already landed, the fire site ignores outcomes), and async runs
    // may route a `queueMessage`. We never gate control flow from it.
    const pre = interpretPrelude(spawn, 'afterFileEdit')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'afterFileEdit',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  marshalStopRequest(hook, payload, session) {
    return { ...copseEnvelope('stop', session, hook.executionRoot), status: payload.status }
  },

  interpretStop(spawn, _payload) {
    // Detached (decision 3): notification-only, but a `queueMessage` follow-up
    // routes through the pending-message queue (decision 4).
    const pre = interpretPrelude(spawn, 'stop')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'stop',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  marshalSubagentStartRequest(hook, payload, session) {
    const base = copseEnvelope('subagentStart', session, hook.executionRoot)
    return {
      ...base,
      subagent_type: payload.subagentType,
      ...(session?.model ? { subagent_model: session.model.model } : {}),
    }
  },

  interpretSubagentStart(spawn, _payload) {
    // Blocking allow/deny gate. `ask` normalizes to `deny` (a spawn cannot pause
    // for interactive approval), matching the Cursor subagentStart contract.
    const pre = interpretPrelude(spawn, 'subagentStart')
    if ('done' in pre) return pre.done
    const { outcome, spineDecision } = copseBlockingOutcome(pre.parsed)
    if (outcome?.decision === 'ask') {
      outcome.decision = 'deny'
      spineDecision.permission = 'deny'
    }
    return { outcome, spineEvent: 'subagentStart', spineDecision, failed: false, parseOk: true }
  },

  marshalSubagentStopRequest(hook, payload, session) {
    return {
      ...copseEnvelope('subagentStop', session, hook.executionRoot),
      subagent_type: payload.subagentType,
      status: payload.status,
    }
  },

  interpretSubagentStop(spawn, payload) {
    const pre = interpretPrelude(spawn, 'subagentStop')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    // A follow-up is consumed only on a completed subagent (parity with Cursor).
    if (queueMessage && payload.status === 'completed') {
      return {
        outcome: null,
        spineEvent: 'subagentStop',
        spineDecision: { queuedMessageChars: queueMessage.text.length },
        failed: false,
        parseOk: true,
        queueMessage,
      }
    }
    return {
      outcome: null,
      spineEvent: 'subagentStop',
      spineDecision: {},
      failed: false,
      parseOk: true,
    }
  },

  marshalAfterToolUseRequest(hook, payload, session) {
    return {
      ...copseEnvelope('afterToolUse', session, hook.executionRoot),
      tool_name: payload.toolName,
      tool_call_id: payload.toolCallId,
      is_error: payload.isError,
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.output !== undefined ? { output: payload.output } : {}),
      ...(payload.durationMs !== undefined ? { duration: payload.durationMs } : {}),
    }
  },

  interpretAfterToolUse(spawn, _payload) {
    // Observation-only (decision 3): a `queueMessage` follow-up may route to the
    // queue, but no control-flow decision is honoured post-hoc.
    const pre = interpretPrelude(spawn, 'afterToolUse')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'afterToolUse',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  marshalSessionStartRequest(hook, payload, session) {
    return {
      ...copseEnvelope('sessionStart', session, hook.executionRoot),
      first_turn: payload.firstTurn,
      session_id: session?.conversationId ?? '',
    }
  },

  interpretSessionStart(spawn, _payload) {
    // Fire-and-forget (decision 3): its actionable output is the `sessionEnv`
    // overlay propagated to later hook spawns.
    const pre = interpretPrelude(spawn, 'sessionStart')
    if ('done' in pre) return pre.done
    const env = copseSessionEnv(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'sessionStart',
      spineDecision: env ? { sessionEnvKeys: Object.keys(env).length } : {},
      failed: false,
      parseOk: true,
      ...(env ? { sessionEnv: env } : {}),
    }
  },

  marshalBeforeDiffApplyRequest(hook, payload, session) {
    return {
      ...copseEnvelope('beforeDiffApply', session, hook.executionRoot),
      file_path: payload.filePath,
    }
  },

  interpretBeforeDiffApply(spawn, _payload) {
    // Blocking allow/deny gate over a queued (or direct) diff apply. `ask`
    // normalizes to `deny` (a diff apply cannot pause a spawned hook for
    // interactive approval — the user already approves diffs in the panel),
    // matching the `subagentStart` contract.
    const pre = interpretPrelude(spawn, 'beforeDiffApply')
    if ('done' in pre) return pre.done
    const { outcome, spineDecision } = copseBlockingOutcome(pre.parsed)
    if (outcome?.decision === 'ask') {
      outcome.decision = 'deny'
      spineDecision.permission = 'deny'
    }
    return { outcome, spineEvent: 'beforeDiffApply', spineDecision, failed: false, parseOk: true }
  },

  marshalAfterDiffApplyRequest(hook, payload, session) {
    return {
      ...copseEnvelope('afterDiffApply', session, hook.executionRoot),
      file_path: payload.filePath,
      applied: payload.applied,
    }
  },

  interpretAfterDiffApply(spawn, _payload) {
    // Async observation (decision 3): the diff already landed / was rejected, so
    // no control-flow decision is honoured post-hoc; a `queueMessage` follow-up
    // may route through the pending-message queue (decision 4).
    const pre = interpretPrelude(spawn, 'afterDiffApply')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'afterDiffApply',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  marshalPermissionDecisionRequest(hook, payload, session) {
    return {
      ...copseEnvelope('permissionDecision', session, hook.executionRoot),
      tool_name: payload.toolName,
      decision: payload.decision,
    }
  },

  interpretPermissionDecision(spawn, _payload) {
    // Async observation (decision 3): a clean post-verdict notification for an
    // audit logger (#840). It can never change the verdict that already
    // happened; a `queueMessage` follow-up may route through the queue.
    const pre = interpretPrelude(spawn, 'permissionDecision')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'permissionDecision',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  marshalPostTurnReviewRequest(hook, payload, session) {
    return {
      ...copseEnvelope('postTurnReview', session, hook.executionRoot),
      issues_found: payload.issuesFound,
      summary: payload.summary,
    }
  },

  interpretPostTurnReview(spawn, _payload) {
    // Async observation (decision 3): the review already produced its verdict,
    // so no control-flow decision is honoured; a `queueMessage` follow-up may
    // route through the pending-message queue (decision 4).
    const pre = interpretPrelude(spawn, 'postTurnReview')
    if ('done' in pre) return pre.done
    const queueMessage = copseQueueMessage(pre.parsed)
    return {
      outcome: null,
      spineEvent: 'postTurnReview',
      spineDecision: queueMessage ? { queuedMessageChars: queueMessage.text.length } : {},
      failed: false,
      parseOk: true,
      ...(queueMessage ? { queueMessage } : {}),
    }
  },

  recordRuntimeFailure(event, command, message) {
    const key = hookErrorKey(event, command)
    if (sessionHookErrors.has(key)) return
    sessionHookErrors.set(key, message)
  },
}
