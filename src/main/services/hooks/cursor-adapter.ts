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
import { dirname, join, relative } from 'node:path'
import micromatch from 'micromatch'
import {
  CURSOR_HOOK_EVENTS,
  isCursorWiredHookEvent,
  type CursorAfterToolHookEvent,
  type CursorHookEvent,
  type CursorHookScope,
  type CursorHooksListResult,
  type CursorHookValidationWarning,
  type CursorPermissionHookEvent,
} from '@shared/types/cursor-hooks.ts'
import type { HooksListResult } from '@shared/types/hooks.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
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
  /**
   * Optional path/glob matcher for `afterFileEdit` (B2). Cursor's native
   * `afterFileEdit` has no declared per-hook path matcher — the vendor pattern
   * is for the script to filter on `file_path` itself — so this is a Copse
   * convenience the Cursor adapter honours: when present, the hook fires only
   * for edited paths matching one of the globs; when absent, it fires for every
   * edit (Cursor's "runs after every file edit" default). Populated from a
   * string or string[] `glob` field on the entry.
   */
  glob?: string[]
  /**
   * Cursor's native per-hook `matcher` (a regex string). D3 honours it across
   * **every** wired event, with the field it tests against selected per event
   * (Cursor's "which field the matcher applies to depends on the hook"):
   *
   * | Event(s)                                   | matched against          |
   * | ------------------------------------------ | ------------------------ |
   * | `beforeShellExecution` / `afterShellExecution` | the full shell command text |
   * | `beforeMCPExecution` / `afterMCPExecution` | the (MCP) tool name      |
   * | `beforeReadFile`                           | the tool type (`Read`)   |
   * | `afterFileEdit`                            | the tool type (`Write`)  |
   * | `beforeSubmitPrompt`                       | the value `UserPromptSubmit` |
   * | `stop`                                     | the value `Stop`         |
   * | `subagentStart` / `subagentStop`           | the subagent type        |
   *
   * An absent matcher fires for every event (Cursor's default). A malformed
   * regex skips the hook (Cursor's docs do not specify invalid-matcher
   * behavior; Copse chooses skip-and-warn so a broken matcher can never
   * accidentally deny/observe every action — consistent with D1's original
   * subagent matcher). Evaluation is centralized in {@link cursorMatcherMatches}
   * / {@link cursorMatcherSubject}; each discovery function calls it (the
   * adapter's dispatch-side filter, decision 8: adapters own matchers).
   */
  matcher?: string
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

/**
 * Normalize an entry's `glob` matcher field (B2) to a clean string[] or
 * undefined. Accepts a single string or an array of strings; anything else (or
 * an empty result) yields undefined so the hook fires for every edit.
 */
function normalizeGlobField(value: unknown): string[] | undefined {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const globs = raw.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
  return globs.length > 0 ? globs : undefined
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
      const glob = normalizeGlobField((entry as { glob?: unknown }).glob)
      const matcherRaw = (entry as { matcher?: unknown }).matcher
      const matcher =
        typeof matcherRaw === 'string' && matcherRaw.trim().length > 0
          ? matcherRaw.trim()
          : undefined
      out.push({
        event,
        command: command.trim(),
        cwd,
        source: path,
        scope,
        failClosed,
        ...(glob ? { glob } : {}),
        ...(matcher ? { matcher } : {}),
      })
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

/**
 * Map a canonical tool name to the Cursor post-tool observation event (D2), if
 * any. The shell/MCP split mirrors {@link cursorEventForTool} — the tool name
 * is the flavor selector for the one canonical `afterToolUse` event. Cursor has
 * no generic post-tool hook, so tools other than shell / MCP have no
 * `afterToolUse` Cursor equivalent and this returns null (the fire site fires
 * for every tool, discovery filters to the shell/MCP flavors).
 */
export function cursorAfterEventForTool(toolName: string): CursorAfterToolHookEvent | null {
  if (toolName === 'run_shell') return 'afterShellExecution'
  if (toolName.startsWith('mcp__')) return 'afterMCPExecution'
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

// ---------------------------------------------------------------------------
// Per-event `matcher` semantics (D3)
// ---------------------------------------------------------------------------
//
// Cursor's per-hook `matcher` is a single regex string, but *which field it
// tests against depends on the event* (vendor docs, "Available matchers by
// hook"). Rather than copy a one-off `new RegExp(...)` into each discovery
// function, evaluation is centralized here: {@link cursorMatcherSubject} selects
// the field per event and {@link cursorMatcherMatches} runs the regex. Every
// discovery function funnels its per-event materials (command text / tool name /
// subagent type) through the same matcher, so the whole Cursor matrix behaves
// consistently and a new event only has to add its subject case.

/**
 * The Cursor tool-type token a file **read** maps to. Cursor's `beforeReadFile`
 * matcher filters by tool type (`Read`, `TabRead`); Copse's `read_file` gate is
 * the (non-tab) `Read` tool, so a `Read` matcher matches and `TabRead` does not
 * (Copse has no inline-tab reads).
 */
const MATCHER_TOOL_TYPE_READ = 'Read'

/**
 * The Cursor tool-type token a file **edit** maps to. Cursor's `afterFileEdit`
 * matcher filters by tool type (`Write`, `TabWrite`); every Copse edit funnels
 * through the diff-queue write path, so it is the (non-tab) `Write` tool.
 */
const MATCHER_TOOL_TYPE_WRITE = 'Write'

/** Cursor matches a `beforeSubmitPrompt` matcher against this fixed token. */
const MATCHER_SUBJECT_SUBMIT_PROMPT = 'UserPromptSubmit'

/** Cursor matches a `stop` matcher against this fixed token. */
const MATCHER_SUBJECT_STOP = 'Stop'

/**
 * The per-event materials a matcher may test against. A discovery function fills
 * only the fields relevant to its event(s); {@link cursorMatcherSubject} picks
 * the right one. Empty/absent fields resolve to the empty string (a matcher
 * against a missing subject simply fails to match).
 */
interface CursorMatcherContext {
  /** Full shell command string — `beforeShellExecution` / `afterShellExecution`. */
  command?: string
  /** Canonical (MCP) tool name — `beforeMCPExecution` / `afterMCPExecution`. */
  toolName?: string
  /** Subagent type — `subagentStart` / `subagentStop`. */
  subagentType?: string
}

/**
 * The string a Cursor `matcher` regex is tested against for `event`. Encodes the
 * vendor's per-event field selection (see the {@link DiscoveredCursorHook.matcher}
 * table). Exhaustive over {@link CursorHookEvent} — a new event must add its
 * subject here (TypeScript flags the missing case).
 */
function cursorMatcherSubject(event: CursorHookEvent, ctx: CursorMatcherContext): string {
  switch (event) {
    case 'beforeShellExecution':
    case 'afterShellExecution':
      return ctx.command ?? ''
    case 'beforeMCPExecution':
    case 'afterMCPExecution':
      return ctx.toolName ?? ''
    case 'beforeReadFile':
      return MATCHER_TOOL_TYPE_READ
    case 'afterFileEdit':
      return MATCHER_TOOL_TYPE_WRITE
    case 'beforeSubmitPrompt':
      return MATCHER_SUBJECT_SUBMIT_PROMPT
    case 'stop':
      return MATCHER_SUBJECT_STOP
    case 'subagentStart':
    case 'subagentStop':
      return ctx.subagentType ?? ''
  }
}

/**
 * Whether a hook's `matcher` covers the event's subject (D3). An absent matcher
 * fires for every action (Cursor's default). A malformed regex skips the hook
 * (skip-and-warn — Cursor's docs are silent on invalid matchers, and skipping
 * is the safe choice: a broken matcher must never accidentally deny/observe
 * every action). This is the single dispatch-side matcher filter every discovery
 * function shares (decision 8: adapters own matchers).
 */
function cursorMatcherMatches(hook: DiscoveredCursorHook, ctx: CursorMatcherContext): boolean {
  if (!hook.matcher) return true
  const subject = cursorMatcherSubject(hook.event, ctx)
  try {
    return new RegExp(hook.matcher).test(subject)
  } catch {
    console.warn(`[cursor-hooks] invalid "${hook.event}" matcher /${hook.matcher}/ — hook skipped`)
    return false
  }
}

/**
 * Discover the Cursor command hooks that gate `payload.toolName`, as registry
 * `CommandHook`s. Only permission events (shell / MCP / read) map onto the
 * canonical `toolGate`; the tool → event mapping ({@link cursorEventForTool}) is
 * the first filter and the per-event `matcher` (D3 — shell command text /
 * MCP tool name / read tool-type) is the second. Each hook's `onFailure` is
 * `closed` when its `failClosed` flag is set, `open` otherwise (the Cursor
 * default).
 */
export async function cursorToolGateHooks(
  payload: HookEventPayloads['toolGate'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'toolGate'>[]> {
  const event = cursorEventForTool(payload.toolName)
  if (!event) return []
  const matcherCtx: CursorMatcherContext = {
    command: stringField(payload.input, 'command'),
    toolName: payload.toolName,
  }
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === event && cursorMatcherMatches(h, matcherCtx))
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
    .filter((h) => h.event === 'beforeSubmitPrompt' && cursorMatcherMatches(h, {}))
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

/**
 * Whether an `afterFileEdit` hook's glob matcher covers the edited path (B2).
 * A hook with no glob fires for every edit (Cursor's default). Otherwise the
 * absolute path is matched, plus — when it is under the workspace — its
 * workspace-relative form (so `**` / `src/**` globs match the natural way), and
 * a basename pass so a bare `*.ts` still matches a nested file.
 */
function afterFileEditMatches(
  hook: DiscoveredCursorHook,
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
      micromatch.isMatch(c, hook.glob as string[], { dot: true }) ||
      micromatch.isMatch(c, hook.glob as string[], { dot: true, basename: true }),
  )
}

/**
 * Discover the Cursor command hooks registered for `afterFileEdit` (B2) whose
 * path matcher covers `payload.filePath`, as registry `CommandHook`s. Same
 * discovery + trust + `failClosed` → `onFailure` mapping as
 * {@link cursorToolGateHooks}; the matcher (per-hook `glob`) is applied here at
 * discovery — the adapter's dispatch-side filter, mirroring how the tool → event
 * matcher gates `toolGate`. The diff-queue / write-tool fire site
 * (`after-file-edit.ts`) registers and fires the survivors through the shared
 * registry → runner → adapter seam.
 */
export async function cursorAfterFileEditHooks(
  payload: HookEventPayloads['afterFileEdit'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'afterFileEdit'>[]> {
  const { hooks } = await discoverHooksDetailed(opts)
  // Two independent filters that must *both* pass (B2 + D3): the Copse-convenience
  // `glob` (matches the edited path) and Cursor's native `matcher` (matches the
  // edit's tool type — `Write`). They are distinct fields with distinct meanings;
  // see `afterFileEditMatches` (glob) and `cursorMatcherMatches` (matcher).
  return hooks
    .filter(
      (h) =>
        h.event === 'afterFileEdit' &&
        afterFileEditMatches(h, payload.filePath, opts.workspaceRoot) &&
        cursorMatcherMatches(h, {}),
    )
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'afterFileEdit' as const,
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
 * Discover the Cursor command hooks registered for `stop` (B3), as registry
 * `CommandHook`s. Same discovery + trust + `failClosed` → `onFailure` mapping as
 * {@link cursorToolGateHooks}; the turn-end / abort fire site (`stop.ts`)
 * registers and fires them **detached** (decision 3, never awaited) through the
 * shared registry → runner → adapter seam. Cursor's `stop` is notification-only,
 * so `failClosed` has nothing to block post-hoc — but the flag still maps to
 * `onFailure` for the spine + Sources error indicator uniformity.
 */
export async function cursorStopHooks(
  _payload: HookEventPayloads['stop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'stop'>[]> {
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'stop' && cursorMatcherMatches(h, {}))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'stop' as const,
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
 * Whether a subagent-lifecycle hook's `matcher` covers the subagent type (D1,
 * now via the centralized D3 matcher). Cursor runs the matcher against the
 * subagent type (`explore`, `shell`, `generalPurpose`, …); Copse's own types are
 * `explore` / `investigate_ci`. Thin wrapper over {@link cursorMatcherMatches}
 * so the subagent field selection reads at the call site.
 */
function subagentTypeMatches(hook: DiscoveredCursorHook, subagentType: string): boolean {
  return cursorMatcherMatches(hook, { subagentType })
}

/**
 * Discover the Cursor command hooks registered for `subagentStart` (D1) whose
 * `matcher` covers the subagent type, as registry `CommandHook`s. Same discovery
 * + trust + `failClosed` → `onFailure` mapping as {@link cursorToolGateHooks};
 * the matcher-on-type filter is applied here at discovery (the adapter's
 * dispatch-side filter). `subagentStart` is **blocking**: the subagent fire site
 * (`subagent.ts`) registers and fires them, and a `deny` prevents the spawn.
 */
export async function cursorSubagentStartHooks(
  payload: HookEventPayloads['subagentStart'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'subagentStart'>[]> {
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'subagentStart' && subagentTypeMatches(h, payload.subagentType))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'subagentStart' as const,
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
 * Discover the Cursor command hooks registered for `subagentStop` (D1) whose
 * `matcher` covers the subagent type, as registry `CommandHook`s. Fired
 * **detached** (decision 3) through the C1 executor by the subagent fire site
 * (`subagent.ts`); a `followup_message` (on `completed`) routes through the
 * pending-message queue (C2/C3), never a bespoke protocol.
 */
export async function cursorSubagentStopHooks(
  payload: HookEventPayloads['subagentStop'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'subagentStop'>[]> {
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === 'subagentStop' && subagentTypeMatches(h, payload.subagentType))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'subagentStop' as const,
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
 * Discover the Cursor command hooks registered for the post-tool observation
 * event that matches `payload.toolName` (D2), as canonical `afterToolUse`
 * `CommandHook`s. The tool → event mapping ({@link cursorAfterEventForTool}) is
 * the flavor selector: `run_shell` → `afterShellExecution`, `mcp__*` →
 * `afterMCPExecution`; any other tool has no Cursor after-event and yields no
 * hooks (so the fire site can fire generically and only shell/MCP hooks run).
 *
 * The tool-type split selects the flavor; the per-hook `matcher` (D3) is then
 * applied on top — the shell command text for `afterShellExecution`, the tool
 * name for `afterMCPExecution` — so a hook can observe only matching commands /
 * tools. Fired **detached** (decision 3) through the C1 executor by the fire
 * site (`after-tool-use.ts`); Cursor's after-events are notification-only, so a
 * `failClosed` flag has nothing to block post-hoc but still maps to `onFailure`
 * for spine + Sources uniformity.
 */
export async function cursorAfterToolUseHooks(
  payload: HookEventPayloads['afterToolUse'],
  opts: DialectDiscoverOpts,
): Promise<CommandHook<'afterToolUse'>[]> {
  const event = cursorAfterEventForTool(payload.toolName)
  if (!event) return []
  const matcherCtx: CursorMatcherContext = {
    command: stringField(payload.input ?? {}, 'command'),
    toolName: payload.toolName,
  }
  const { hooks } = await discoverHooksDetailed(opts)
  return hooks
    .filter((h) => h.event === event && cursorMatcherMatches(h, matcherCtx))
    .map((h) => {
      auditProjectHook(h)
      return {
        id: h.command,
        event: 'afterToolUse' as const,
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
 * Cursor `subagentStop` stdout: an optional `followup_message` that auto-
 * continues the parent (consumed only on `status: completed`). Snake and camel
 * spellings accepted, mirroring the other Cursor response parsers.
 */
interface CursorSubagentStopResponse {
  followup_message?: string
  followupMessage?: string
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

/**
 * The base agent-session envelope every Cursor hook payload carries (B4). The
 * real `conversation_id` (thread id) and `generation_id` (turn id) come from the
 * host-captured {@link AgentSessionInfo}; when there is no active run the ids are
 * empty strings (the pre-B4 behavior). The running model is stamped as Cursor's
 * `model` / `model_id` / `model_params` (vendor contract; `model_params` is the
 * `{ id, value }[]` array shape, not an object) on **every** agent-session
 * event — Cursor sends model identity on all of them.
 */
function agentSessionEnvelope(
  event: CursorHookEvent,
  session: AgentSessionInfo | undefined,
): Record<string, unknown> {
  const root = getWorkspaceRoot()
  const base: Record<string, unknown> = {
    conversation_id: session?.conversationId ?? '',
    generation_id: session?.generationId ?? '',
    hook_event_name: event,
    workspace_roots: root ? [root] : [],
  }
  if (session?.model) {
    base['model'] = session.model.model
    base['model_id'] = session.model.modelId
    base['model_params'] = session.model.modelParams
  }
  return base
}

/** The concrete Cursor dialect adapter the runner delegates to. */
export const cursorAdapter: DialectAdapter = {
  dialect: 'cursor',

  marshalToolGateRequest(_hook, payload, session) {
    const event = cursorEventForTool(payload.toolName)
    if (!event) return null
    const base = agentSessionEnvelope(event, session)
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
    // beforeReadFile: the host reads the file eagerly for read_file gates and
    // fills `payload.fileContent` (B4), so a redaction/secret-detection hook can
    // inspect the bytes and deny. Cursor's beforeReadFile response is allow/deny
    // only (no content-rewrite in the vendor contract), so "redact" == deny.
    return {
      ...base,
      file_path: stringField(payload.input, 'path'),
      content: payload.fileContent ?? '',
    }
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

  marshalBeforeSubmitPromptRequest(_hook, payload, session) {
    // Cursor's beforeSubmitPrompt stdin: the composed prompt plus attachments
    // (empty until an attachments payload channel exists) and the standard
    // agent-session envelope (real conversation/generation ids + model — B4).
    return {
      ...agentSessionEnvelope('beforeSubmitPrompt', session),
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

  marshalAfterFileEditRequest(_hook, payload, session) {
    // Cursor's afterFileEdit stdin: the edited file's absolute path, the edits
    // (old_string/new_string pairs) and the standard agent-session envelope
    // (real conversation/generation ids + model — B4). The canonical payload
    // carries only the path in v1, so `edits` is empty — enough for the common
    // formatter/accounting hook, which keys off file_path.
    return {
      ...agentSessionEnvelope('afterFileEdit', session),
      file_path: payload.filePath,
      edits: [],
    }
  },

  interpretAfterFileEdit(spawn: HookSpawnResult, _payload): DialectInterpretation {
    // Cursor's afterFileEdit is a notification: it "cannot block the agent or
    // return data to it" (vendor docs). So stdout never yields a control-flow
    // decision — the outcome is always null. We still surface a crash / timeout
    // / non-zero exit as `failed` for the Sources per-hook error indicator and
    // the spine, but the fire site (after-file-edit.ts) never acts on it — the
    // edit has already landed. `failClosed` therefore has nothing to block here.
    const spineEvent = 'afterFileEdit'
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
    if (spawn.exitCode !== null && spawn.exitCode !== 0) {
      return {
        ...base,
        failed: true,
        parseOk: true,
        runtimeError: `exited with code ${String(spawn.exitCode)}`,
      }
    }
    return { ...base, failed: false, parseOk: true }
  },

  marshalStopRequest(_hook, payload, session) {
    // Cursor's stop stdin: the terminal `status` plus the standard agent-session
    // envelope (real conversation/generation ids + model — B4). The fire site
    // captures the session by value before dispatching detached, so a slow stop
    // hook still marshals the finished turn's identity (decision 3).
    return {
      ...agentSessionEnvelope('stop', session),
      status: payload.status,
    }
  },

  interpretStop(spawn: HookSpawnResult, _payload): DialectInterpretation {
    // Cursor's stop is a notification: it carries only `status` and returns
    // nothing (vendor docs). So stdout never yields a control-flow decision —
    // the outcome is always null. We still surface a crash / timeout / non-zero
    // exit as `failed` for the Sources per-hook error indicator and the spine,
    // but the fire site (stop.ts) fires detached and never acts on it (decision
    // 3, no drain barrier), so `failClosed` has nothing to block. Any
    // `followup_message` a dialect might return is *not* parsed into an action
    // here — follow-ups route through the pending-message queue (C2), never a
    // bespoke stop protocol (decision 4).
    const spineEvent = 'stop'
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
    if (spawn.exitCode !== null && spawn.exitCode !== 0) {
      return {
        ...base,
        failed: true,
        parseOk: true,
        runtimeError: `exited with code ${String(spawn.exitCode)}`,
      }
    }
    return { ...base, failed: false, parseOk: true }
  },

  marshalSubagentStartRequest(_hook, payload, session) {
    // Cursor's subagentStart stdin: the subagent type (the matcher target) and
    // the resolved `subagent_model` (B4 — the model the subagent will run,
    // including a local→cloud fallback), plus the standard agent-session
    // envelope. The host sets `session.model` to the subagent's resolved model,
    // so the envelope `model` and `subagent_model` both report it.
    const base = agentSessionEnvelope('subagentStart', session)
    return {
      ...base,
      subagent_type: payload.subagentType,
      ...(session?.model ? { subagent_model: session.model.model } : {}),
    }
  },

  interpretSubagentStart(spawn: HookSpawnResult, _payload): DialectInterpretation {
    // Cursor's subagentStart is a blocking allow/deny gate (`ask` is treated as
    // deny — vendor contract). A crash / timeout / invalid JSON is a `failed`
    // run the runner resolves per `onFailure` (failClosed blocks the spawn).
    const spineEvent = 'subagentStart'
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
    const { outcome, spineDecision } = subagentStartOutcomeFromResponse(parsed)
    return { outcome, spineEvent, spineDecision, failed: false, parseOk: true }
  },

  marshalSubagentStopRequest(_hook, payload, session) {
    // Cursor's subagentStop stdin: the subagent type + terminal status, plus the
    // standard agent-session envelope. The fire site captures the session by
    // value before dispatching detached (decision 3).
    return {
      ...agentSessionEnvelope('subagentStop', session),
      subagent_type: payload.subagentType,
      status: payload.status,
    }
  },

  interpretSubagentStop(spawn: HookSpawnResult, payload): DialectInterpretation {
    // Cursor's subagentStop is detached (decision 3): it returns nothing that
    // gates control flow. Its one actionable output is `followup_message`
    // (consumed only on `status: completed`), which routes through the pending-
    // message queue (C2/C3), never a bespoke protocol — so we surface it as a
    // `queueMessage` the runner forwards to `onAsyncOutcome`. A crash / timeout /
    // non-zero exit is recorded `failed` for the spine + Sources only.
    const spineEvent = 'subagentStop'
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
    if (spawn.exitCode !== null && spawn.exitCode !== 0) {
      return {
        ...base,
        failed: true,
        parseOk: true,
        runtimeError: `exited with code ${String(spawn.exitCode)}`,
      }
    }

    const text = spawn.stdout.trim()
    if (!text) return { ...base, failed: false, parseOk: true }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A notification hook that prints noise is not a failure to block on
      // (nothing to block post-hoc); record parseOk:false for the spine only.
      return { ...base, failed: false, parseOk: false }
    }
    const followup = firstString(
      (parsed as CursorSubagentStopResponse).followup_message,
      (parsed as CursorSubagentStopResponse).followupMessage,
    )
    // The vendor consumes `followup_message` only on a completed subagent.
    if (followup !== undefined && payload.status === 'completed') {
      const spineDecision: SpineHookRunDecision = { queuedMessageChars: followup.length }
      return {
        ...base,
        queueMessage: { text: followup, sendNow: false },
        spineDecision,
        failed: false,
        parseOk: true,
      }
    }
    return { ...base, failed: false, parseOk: true }
  },

  marshalAfterToolUseRequest(_hook, payload, session) {
    // Cursor splits the canonical afterToolUse into two payload flavors by tool
    // name (D2): afterShellExecution carries the `command` + captured `output`
    // + `duration`; afterMCPExecution carries `tool_name` + `tool_input` (JSON
    // string) + `result_json` + `duration`. `output` is already capped at the
    // fire site (a tool's stdout is unbounded), so it is safe to marshal
    // verbatim. Returns null when the tool has no Cursor after-event (the
    // marshaller's final guard past discovery matching).
    const event = cursorAfterEventForTool(payload.toolName)
    if (!event) return null
    const base = agentSessionEnvelope(event, session)
    const duration = payload.durationMs ?? 0
    if (event === 'afterShellExecution') {
      return {
        ...base,
        command: stringField(payload.input ?? {}, 'command'),
        output: payload.output ?? '',
        duration,
      }
    }
    // afterMCPExecution: `tool_input` is the JSON params *string*, `result_json`
    // the JSON result *string* — both stringified per the vendor contract.
    return {
      ...base,
      tool_name: payload.toolName,
      tool_input: JSON.stringify(payload.input ?? {}),
      result_json: payload.output ?? '',
      duration,
    }
  },

  interpretAfterToolUse(spawn: HookSpawnResult, payload): DialectInterpretation {
    // Cursor's after-events are fire-and-forget (detached, decision 3): they
    // return nothing that gates control flow, so the outcome is always null. We
    // still surface a crash / timeout / non-zero exit as `failed` for the
    // Sources per-hook error indicator + the spine, but the fire site
    // (after-tool-use.ts) never acts on it — the tool has already run. The spine
    // event is the resolved dialect flavor (afterShell/afterMCP), so the Sources
    // error key matches discovery/list.
    const spineEvent = cursorAfterEventForTool(payload.toolName) ?? 'afterToolUse'
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
    if (spawn.exitCode !== null && spawn.exitCode !== 0) {
      return {
        ...base,
        failed: true,
        parseOk: true,
        runtimeError: `exited with code ${String(spawn.exitCode)}`,
      }
    }
    return { ...base, failed: false, parseOk: true }
  },

  recordRuntimeFailure(event, command, message) {
    const key = hookErrorKey(event, command)
    if (sessionHookErrors.has(key)) return
    sessionHookErrors.set(key, message)
  },
}

/**
 * Normalize a Cursor `subagentStart` response (D1). `permission: deny` blocks
 * the spawn; `ask` is **treated as deny** (Cursor: "`ask` is not supported for
 * `subagentStart`"). `allow` (or an absent permission) proceeds. `user_message`
 * rides along for surfacing on a deny.
 */
function subagentStartOutcomeFromResponse(parsed: unknown): {
  outcome: BlockingHookOutcome | null
  spineDecision: SpineHookRunDecision
} {
  if (typeof parsed !== 'object' || parsed === null) return { outcome: null, spineDecision: {} }
  const res = parsed as CursorHookResponse & { user_message?: string; agent_message?: string }
  const userMessage = firstString(res.userMessage, res.user_message)
  const agentMessage = firstString(res.agentMessage, res.agent_message)
  const outcome: BlockingHookOutcome = {}
  // `ask` → `deny` (vendor contract for subagentStart); `allow` stays allow.
  if (res.permission === 'deny' || res.permission === 'ask') outcome.decision = 'deny'
  else if (res.permission === 'allow') outcome.decision = 'allow'
  if (agentMessage !== undefined) outcome.agentMessage = agentMessage
  if (userMessage !== undefined) outcome.userMessage = userMessage
  const spineDecision: SpineHookRunDecision = {
    ...(outcome.decision !== undefined ? { permission: outcome.decision } : {}),
    ...(agentMessage !== undefined ? { agentMessageChars: agentMessage.length } : {}),
    ...(userMessage !== undefined ? { userMessageChars: userMessage.length } : {}),
  }
  return { outcome: Object.keys(outcome).length > 0 ? outcome : null, spineDecision }
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
