import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CURSOR_HOOK_EVENTS,
  type CursorHookEvent,
  type CursorHookScope,
  type CursorHookSummary,
  type CursorPermissionHookEvent,
} from '@shared/types/cursor-hooks.ts'
import type { HookSummary } from '@shared/types/hooks.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { recordCommandHookRun } from '../hook-run-recorder.ts'

/** Hooks that take longer than this are treated as failed-open (allow). */
const HOOK_TIMEOUT_MS = 5_000

/** A parsed hook command together with the config that declared it. */
interface DiscoveredHook {
  event: CursorHookEvent
  command: string
  /** Directory of the declaring `hooks.json`; relative commands resolve against it. */
  cwd: string
  source: string
  scope: CursorHookScope
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
 * Parse one `hooks.json`. The shape is `{ version, hooks: { <event>: [{ command }] } }`.
 * Unknown events and malformed entries are skipped rather than throwing — a bad hook
 * config should never break the agent loop.
 */
async function parseHooksConfig(path: string, scope: CursorHookScope): Promise<DiscoveredHook[]> {
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

  // parsed comes from JSON.parse and can legitimately be null (e.g. `null`/`false`);
  // the cast type hides that, so the optional chain guards the real runtime case.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hooks = (parsed as { hooks?: unknown })?.hooks
  if (typeof hooks !== 'object' || hooks === null) return []

  const cwd = dirname(path)
  const out: DiscoveredHook[] = []
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!isHookEvent(event) || !Array.isArray(entries)) continue
    for (const entry of entries) {
      // entry is an element of a parsed JSON array and can be null; the cast type
      // hides that, so the optional chain guards the genuine runtime case.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const command = (entry as { command?: unknown })?.command
      if (typeof command !== 'string' || !command.trim()) continue
      out.push({ event, command: command.trim(), cwd, source: path, scope })
    }
  }
  return out
}

/**
 * Discover all hooks visible in the current context.
 *
 * - User hooks (`~/.cursor/hooks.json`) are always discovered.
 * - Project hooks (`<root>/.cursor/hooks.json`) are only discovered when the workspace
 *   is trusted, because honouring them spawns scripts from a possibly-cloned repo.
 */
async function discoverHooks(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<DiscoveredHook[]> {
  const configs: Array<Promise<DiscoveredHook[]>> = [
    parseHooksConfig(userHooksConfigPath(), 'user'),
  ]
  if (opts.workspaceRoot && opts.projectTrusted) {
    configs.push(parseHooksConfig(projectHooksConfigPath(opts.workspaceRoot), 'project'))
  }
  const results = await Promise.all(configs)
  return results.flat()
}

/** Diagnostics / Settings → Sources — discovered Cursor hooks, regardless of enablement. */
export async function listCursorHooks(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<CursorHookSummary[]> {
  const hooks = await discoverHooks(opts)
  return hooks.map(({ event, command, source, scope }) => ({ event, command, source, scope }))
}

/** Cursor hooks as the shared {@link HookSummary} shape used by `hooks:list`. */
export async function listCursorHooksAsSummaries(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<HookSummary[]> {
  const hooks = await listCursorHooks(opts)
  return hooks.map((h) => ({
    family: 'cursor' as const,
    event: h.event,
    command: h.command,
    source: h.source,
    scope: h.scope,
  }))
}

export type CursorHookPermission = 'allow' | 'deny' | 'ask'

interface HookPermissionResponse {
  permission?: CursorHookPermission
  agentMessage?: string
  userMessage?: string
}

export interface CursorHookDecision {
  permission: CursorHookPermission
  /** Message a denying/asking hook wants surfaced to the agent, if any. */
  agentMessage?: string
}

/**
 * Project (repo-supplied) hook commands already logged this session, so we warn at most
 * once per distinct command rather than on every gated tool call.
 */
const warnedProjectHookCommands = new Set<string>()

/**
 * Emit a one-time audit warning the first time a project-supplied hook command runs.
 *
 * Honouring a project hook means executing arbitrary shell from a possibly-cloned repo,
 * outside the sandbox, with non-LLM tool tokens in `env` (see "Security" in
 * `docs/cursor-hooks.md`). Trust is the consent for that; this log just makes it
 * auditable. Best-effort and side-effect-free w.r.t. the decision — it must never affect
 * the fail-open semantics or the agent loop.
 */
function auditProjectHook(hook: DiscoveredHook): void {
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
 * Everything observed about one spawned hook execution. `response` is what the
 * permission reduction consumes; the rest feeds the always-on spine record
 * (decision 6 of docs/plans/hooks-and-feature-packs.md).
 */
interface HookCommandExecution {
  response: HookPermissionResponse | null
  /** Raw captured streams (stored verbatim as thread blobs). */
  stdout: string
  stderr: string
  /** Process exit code; null when killed (timeout / output cap) or spawn failed. */
  exitCode: number | null
  startedAt: number
  durationMs: number
  /**
   * Whether stdout was successfully converted into a response. Empty stdout is
   * an intentional no-response (`true`); non-empty non-JSON output — e.g. a
   * debug print corrupting the response channel — is `false`.
   */
  parseOk: boolean
}

/** Cap captured stream sizes so a runaway hook can't exhaust memory. */
const OUTPUT_CAP_BYTES = 1_000_000

/** Spawn one hook, feed it the JSON payload on stdin, and parse its stdout JSON. */
function runHookCommand(
  hook: DiscoveredHook,
  payload: unknown,
  signal?: AbortSignal,
): Promise<HookCommandExecution> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let settled = false
    const finish = (response: HookPermissionResponse | null, parseOk: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        response,
        stdout,
        stderr,
        exitCode,
        startedAt,
        durationMs: Date.now() - startedAt,
        parseOk,
      })
    }

    auditProjectHook(hook)

    // Project hooks are arbitrary repo-supplied shell, run outside the project sandbox
    // with non-LLM tool tokens (e.g. GITHUB_TOKEN) present in `env`. This is gated by
    // workspace trust + `cursorHooksEnabled`; see "Security" in docs/cursor-hooks.md.
    const child = spawn(hook.command, {
      cwd: hook.cwd,
      shell: true,
      env: envForRendererChildProcess(),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, false)
    }, HOOK_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      // stdout is the response channel: a runaway response is fatal to the hook.
      if (stdout.length > OUTPUT_CAP_BYTES) child.kill('SIGKILL')
    })
    // stderr is captured for the spine record (decision 6 — previously
    // discarded via `'ignore'`). Overflow only truncates the capture; it never
    // kills the hook, because stderr chatter carries no decision.
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length <= OUTPUT_CAP_BYTES) stderr += chunk.toString('utf-8')
    })
    child.on('error', () => {
      finish(null, false)
    })
    child.on('close', (code) => {
      exitCode = code
      const text = stdout.trim()
      if (!text) {
        // Empty stdout is an intentional no-response, not a parse failure.
        finish(null, true)
        return
      }
      try {
        finish(JSON.parse(text) as HookPermissionResponse, true)
      } catch {
        finish(null, false)
      }
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch {
      finish(null, false)
    }
  })
}

/**
 * Run all permission hooks registered for `event` and reduce their responses to a
 * single decision. Hooks fail open: a missing config, crash, timeout, or unparseable
 * response is treated as `allow` so a broken hook never silently blocks the agent.
 *
 * Reduction precedence: any `deny` wins; otherwise any `ask`; otherwise `allow`. This
 * lets hooks *tighten* Copse's own permission gate but never loosen it (an `allow`
 * from a hook still flows through Copse's normal prompting).
 */
export async function runPermissionHooks(
  event: CursorPermissionHookEvent,
  payload: Record<string, unknown>,
  opts: { workspaceRoot: string | null; projectTrusted: boolean; signal?: AbortSignal },
): Promise<CursorHookDecision> {
  const hooks = (await discoverHooks(opts)).filter((h) => h.event === event)
  if (hooks.length === 0) return { permission: 'allow' }

  const base = {
    conversation_id: '',
    generation_id: '',
    hook_event_name: event,
    workspace_roots: opts.workspaceRoot ? [opts.workspaceRoot] : [],
  }

  const executions = await Promise.all(
    hooks.map((hook) => runHookCommand(hook, { ...base, ...payload }, opts.signal)),
  )

  // Always-on spine recording (decision 6): one hook_run line per execution,
  // with the raw stdout/stderr bytes as blobs. Attribution/persistence live in
  // the recorder; a run with no attributable thread records nothing.
  hooks.forEach((hook, i) => {
    const execution = executions[i]
    if (!execution) return
    recordCommandHookRun({
      event: hook.event,
      hookId: hook.command,
      startedAt: execution.startedAt,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      parseOk: execution.parseOk,
      decision: {
        ...(execution.response?.permission !== undefined
          ? { permission: execution.response.permission }
          : {}),
        ...(execution.response?.agentMessage !== undefined
          ? { agentMessageChars: execution.response.agentMessage.length }
          : {}),
        ...(execution.response?.userMessage !== undefined
          ? { userMessageChars: execution.response.userMessage.length }
          : {}),
      },
      stdout: execution.stdout,
      stderr: execution.stderr,
    })
  })

  let decision: CursorHookDecision = { permission: 'allow' }
  for (const { response: res } of executions) {
    const permission = res?.permission
    if (permission === 'deny') {
      return {
        permission: 'deny',
        ...(res?.agentMessage ? { agentMessage: res.agentMessage } : {}),
      }
    }
    if (permission === 'ask' && decision.permission === 'allow') {
      decision = {
        permission: 'ask',
        ...(res?.agentMessage ? { agentMessage: res.agentMessage } : {}),
      }
    }
  }
  return decision
}
