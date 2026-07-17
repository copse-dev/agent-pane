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
import type { HookScope, HookSummary } from '@shared/types/hooks.ts'
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

/** A parsed Claude command hook ready to spawn. */
interface DiscoveredClaudeHook {
  event: 'PreToolUse'
  /** Tool-name matcher (`Bash`, `Edit|Write`, `mcp__.*`, `*`, or omitted = all). */
  matcher?: string
  command: string
  /** Directory of the declaring settings file; relative commands resolve against it. */
  cwd: string
  source: string
  scope: HookScope
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

/**
 * Parse one Claude `settings.json` for command hooks under `hooks.PreToolUse`.
 * Unknown events, non-command handlers, and malformed entries are skipped — a
 * bad settings file must never break the agent loop.
 */
async function parseClaudeSettings(
  path: string,
  scope: HookScope,
): Promise<DiscoveredClaudeHook[]> {
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf-8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  // parsed comes from JSON.parse and can legitimately be null; optional-chain.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hooksRoot = (parsed as { hooks?: unknown })?.hooks
  if (typeof hooksRoot !== 'object' || hooksRoot === null) return []

  const preToolUse = (hooksRoot as Record<string, unknown>)['PreToolUse']
  if (!Array.isArray(preToolUse)) return []

  const cwd = dirname(path)
  const out: DiscoveredClaudeHook[] = []
  for (const group of preToolUse) {
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
      const entry: DiscoveredClaudeHook = {
        event: 'PreToolUse',
        command: command.trim(),
        cwd,
        source: path,
        scope,
      }
      if (matcher !== undefined) entry.matcher = matcher
      out.push(entry)
    }
  }
  return out
}

async function discoverClaudeHooks(opts: DialectDiscoverOpts): Promise<DiscoveredClaudeHook[]> {
  const configs: Array<Promise<DiscoveredClaudeHook[]>> = [
    parseClaudeSettings(userClaudeSettingsPath(), 'user'),
  ]
  if (opts.workspaceRoot && opts.projectTrusted) {
    configs.push(parseClaudeSettings(projectClaudeSettingsPath(opts.workspaceRoot), 'project'))
    configs.push(parseClaudeSettings(projectClaudeLocalSettingsPath(opts.workspaceRoot), 'project'))
  }
  const results = await Promise.all(configs)
  return results.flat()
}

/** Diagnostics / Settings → Sources — discovered Claude hooks, regardless of enablement. */
export async function listClaudeHooks(opts: DialectDiscoverOpts): Promise<HookSummary[]> {
  const hooks = await discoverClaudeHooks(opts)
  return hooks.map((h) => {
    const summary: HookSummary = {
      family: 'claude',
      event: h.event,
      command: h.command,
      source: h.source,
      scope: h.scope,
      // Only PreToolUse is wired today, and that is all `discoverClaudeHooks`
      // returns — so every discovered Claude hook is currently supported.
      supported: true,
    }
    if (h.matcher !== undefined) summary.matcher = h.matcher
    return summary
  })
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
        cwd: h.cwd,
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
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

  const permissionRaw = (specific as { permissionDecision?: unknown }).permissionDecision
  if (!isPermissionDecision(permissionRaw)) return { outcome: null, parseOk: true }

  const permission = mapClaudeDecision(permissionRaw)
  const reasonRaw = (specific as { permissionDecisionReason?: unknown }).permissionDecisionReason
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : ''
  const outcome: BlockingHookOutcome = { decision: permission }
  if (reason) outcome.agentMessage = reason
  return { outcome, parseOk: true }
}

/** The concrete Claude dialect adapter the runner delegates to. */
export const claudeAdapter: DialectAdapter = {
  dialect: 'claude',

  // `_session` (B4 agent-session identity) is accepted for interface parity but
  // unused: Claude's PreToolUse contract has no conversation/generation/model
  // fields — Claude carries an optional `model` on `sessionStart` only (H4 fire
  // site), matching the vendor audit in docs/plans/hooks-and-feature-packs.md.
  marshalToolGateRequest(_hook, payload, _session) {
    const mapped = claudeToolForTool(payload.toolName, payload.input)
    if (!mapped) return null
    return {
      session_id: '',
      transcript_path: '',
      cwd: getWorkspaceRoot() ?? '',
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

  // Claude hook error state is not surfaced in Sources today (parity with the
  // pre-A2 behavior); the hook_run spine record still captures every failure.
  recordRuntimeFailure() {
    /* no-op: Claude Sources rows do not carry a per-hook lastError */
  },
}
