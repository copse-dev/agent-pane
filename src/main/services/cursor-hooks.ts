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
import { envForRendererChildProcess } from './child-process-env.ts'

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

/** Diagnostics / future Settings UI — discovered hooks, regardless of enablement. */
export async function listCursorHooks(opts: {
  workspaceRoot: string | null
  projectTrusted: boolean
}): Promise<CursorHookSummary[]> {
  const hooks = await discoverHooks(opts)
  return hooks.map(({ event, command, source, scope }) => ({ event, command, source, scope }))
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

/** Spawn one hook, feed it the JSON payload on stdin, and parse its stdout JSON. */
function runHookCommand(
  hook: DiscoveredHook,
  payload: unknown,
  signal?: AbortSignal,
): Promise<HookPermissionResponse | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: HookPermissionResponse | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    auditProjectHook(hook)

    // Project hooks are arbitrary repo-supplied shell, run outside the project sandbox
    // with non-LLM tool tokens (e.g. GITHUB_TOKEN) present in `env`. This is gated by
    // workspace trust + `cursorHooksEnabled`; see "Security" in docs/cursor-hooks.md.
    const child = spawn(hook.command, {
      cwd: hook.cwd,
      shell: true,
      env: envForRendererChildProcess(),
      stdio: ['pipe', 'pipe', 'ignore'],
      signal,
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, HOOK_TIMEOUT_MS)

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      // Cap captured output so a runaway hook can't exhaust memory.
      if (stdout.length > 1_000_000) child.kill('SIGKILL')
    })
    child.on('error', () => {
      finish(null)
    })
    child.on('close', () => {
      const text = stdout.trim()
      if (!text) {
        finish(null)
        return
      }
      try {
        finish(JSON.parse(text) as HookPermissionResponse)
      } catch {
        finish(null)
      }
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch {
      finish(null)
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

  const responses = await Promise.all(
    hooks.map((hook) => runHookCommand(hook, { ...base, ...payload }, opts.signal)),
  )

  let decision: CursorHookDecision = { permission: 'allow' }
  for (const res of responses) {
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
