import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudePermissionDecision } from '@shared/types/claude-hooks.ts'
import { CLAUDE_PERMISSION_DECISIONS } from '@shared/types/claude-hooks.ts'
import type { HookScope, HookSummary } from '@shared/types/hooks.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { recordCommandHookRun } from '../hook-run-recorder.ts'
import type { CursorHookDecision, CursorHookPermission } from './cursor-hooks.ts'

/** Hooks that take longer than this are treated as failed-open (allow). */
const HOOK_TIMEOUT_MS = 5_000

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

async function discoverClaudeHooks(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<DiscoveredClaudeHook[]> {
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
export async function listClaudeHooks(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<HookSummary[]> {
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
 * Project (repo-supplied) hook commands already logged this session, so we warn at most
 * once per distinct command rather than on every gated tool call.
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

interface HookProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  startedAt: number
  durationMs: number
}

/** Spawn one Claude hook command; capture exit code, stdout, and stderr. */
function runClaudeHookCommand(
  hook: DiscoveredClaudeHook,
  payload: unknown,
  signal?: AbortSignal,
): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const finish = (value: Omit<HookProcessResult, 'startedAt' | 'durationMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...value, startedAt, durationMs: Date.now() - startedAt })
    }

    auditProjectHook(hook)

    const child = spawn(hook.command, {
      cwd: hook.cwd,
      shell: true,
      env: envForRendererChildProcess(),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: null, stdout: '', stderr: '' })
    }, HOOK_TIMEOUT_MS)

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      if (stdout.length > 1_000_000) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (stderr.length > 1_000_000) child.kill('SIGKILL')
    })
    child.on('error', () => {
      finish({ exitCode: null, stdout: '', stderr: '' })
    })
    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr })
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch {
      finish({ exitCode: null, stdout: '', stderr: '' })
    }
  })
}

/** True when stdout is empty (intentional no-decision) or valid JSON. */
function claudeStdoutParsesClean(result: HookProcessResult): boolean {
  const text = result.stdout.trim()
  if (!text) return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function mapClaudeDecision(decision: ClaudePermissionDecision): CursorHookPermission {
  // `defer` ends a Claude Code query so it can resume later — Copse has no defer
  // path, so treat it as `ask` (surface / fall through to our gate).
  if (decision === 'defer') return 'ask'
  return decision
}

/**
 * Interpret one Claude command-hook result. Exit code 2 is an immediate deny
 * (stderr becomes the agent message). On exit 0, JSON
 * `hookSpecificOutput.permissionDecision` is honoured. Everything else fails open.
 */
function decisionFromClaudeResult(result: HookProcessResult): CursorHookDecision {
  if (result.exitCode === 2) {
    const reason = result.stderr.trim() || result.stdout.trim()
    return reason ? { permission: 'deny', agentMessage: reason } : { permission: 'deny' }
  }
  if (result.exitCode !== 0) return { permission: 'allow' }

  const text = result.stdout.trim()
  if (!text) return { permission: 'allow' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { permission: 'allow' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { permission: 'allow' }

  // Universal: continue:false stops the agent — treat as deny for our gate.
  if ((parsed as { continue?: unknown }).continue === false) {
    const stopReason = (parsed as { stopReason?: unknown }).stopReason
    return typeof stopReason === 'string' && stopReason.trim()
      ? { permission: 'deny', agentMessage: stopReason.trim() }
      : { permission: 'deny' }
  }

  const specific = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (typeof specific !== 'object' || specific === null) return { permission: 'allow' }

  const permissionRaw = (specific as { permissionDecision?: unknown }).permissionDecision
  if (!isPermissionDecision(permissionRaw)) return { permission: 'allow' }

  const permission = mapClaudeDecision(permissionRaw)
  const reason = (specific as { permissionDecisionReason?: unknown }).permissionDecisionReason
  if (typeof reason === 'string' && reason.trim()) {
    return { permission, agentMessage: reason.trim() }
  }
  return { permission }
}

/**
 * Run matching Claude `PreToolUse` command hooks for a Copse tool call and reduce
 * to a single decision. Same reduction as Cursor hooks: any `deny` wins, else
 * any `ask`, else `allow`. Fail-open on crash/timeout/non-JSON.
 */
export async function runClaudePreToolUseHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: { workspaceRoot: string | null; projectTrusted: boolean; signal?: AbortSignal },
): Promise<CursorHookDecision> {
  const hooks = (await discoverClaudeHooks(opts)).filter((h) =>
    claudeMatcherMatches(h.matcher, toolName),
  )
  if (hooks.length === 0) return { permission: 'allow' }

  const payload = {
    session_id: '',
    transcript_path: '',
    cwd: opts.workspaceRoot ?? '',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  }

  const results = await Promise.all(
    hooks.map((hook) => runClaudeHookCommand(hook, payload, opts.signal)),
  )

  // Always-on spine recording (decision 6): one hook_run line per execution,
  // raw stdout/stderr as blobs. Recording never affects the decision reduction.
  hooks.forEach((hook, i) => {
    const result = results[i]
    if (!result) return
    const decision = decisionFromClaudeResult(result)
    recordCommandHookRun({
      event: 'PreToolUse',
      hookId: hook.command,
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      // Claude semantics: exit 0 with empty stdout and exit 2 are intentional
      // protocol outcomes; anything else that fell through is a failed parse.
      parseOk: result.exitCode === 2 || claudeStdoutParsesClean(result),
      decision: {
        permission: decision.permission,
        ...(decision.agentMessage !== undefined
          ? { agentMessageChars: decision.agentMessage.length }
          : {}),
      },
      stdout: result.stdout,
      stderr: result.stderr,
    })
  })

  let decision: CursorHookDecision = { permission: 'allow' }
  for (const result of results) {
    const next = decisionFromClaudeResult(result)
    if (next.permission === 'deny') return next
    if (next.permission === 'ask' && decision.permission === 'allow') {
      decision = next
    }
  }
  return decision
}
