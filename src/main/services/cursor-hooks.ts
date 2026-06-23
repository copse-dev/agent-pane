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

  const hooks = (parsed as { hooks?: unknown })?.hooks
  if (typeof hooks !== 'object' || hooks === null) return []

  const cwd = dirname(path)
  const out: DiscoveredHook[] = []
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!isHookEvent(event) || !Array.isArray(entries)) continue
    for (const entry of entries) {
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
    child.on('error', () => finish(null))
    child.on('close', () => {
      const text = stdout.trim()
      if (!text) return finish(null)
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
