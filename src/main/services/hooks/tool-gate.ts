// Tool-gate orchestration (A2) — maps the permission gate's tool check onto the
// canonical `toolGate` event (plan's canonical-events table: `toolGate` "maps
// beforeShell/MCP/ReadFile + PreToolUse").
//
// The permission gate calls {@link runToolGateHooks} with a plain tool check; we
// discover the matching command hooks from every dialect adapter, register them
// on a fresh registry, and fire `toolGate` through the same
// registry → runner → adapter seam every later phase uses. The registry runs the
// hooks via the host command runner (real spawn), applies each dialect's failure
// semantics (decision 9), and returns normalized outcomes we reduce to one gate
// decision. Hooks can only **tighten** the gate: an `allow` still flows through
// Copse's own prompting; only a `deny` short-circuits.
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { HookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorToolGateHooks } from './cursor-adapter.ts'
import { claudeToolGateHooks } from './claude-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'

/** A permission-style verdict reduced from the tool-gate hooks. */
export type HookGatePermission = 'allow' | 'deny' | 'ask'

export interface HookGateDecision {
  permission: HookGatePermission
  /** Message a denying/asking hook wants surfaced to the agent, if any. */
  agentMessage?: string
  /** Message a denying/asking hook wants shown to the user, if any. */
  userMessage?: string
}

export interface ToolGateCheck {
  toolName: string
  args: unknown
}

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? { ...(args as Record<string, unknown>) } : {}
}

/** Cap the file content handed to a `beforeReadFile` hook (bounds a huge file). */
const MAX_READ_FILE_HOOK_CONTENT = 1024 * 1024

/**
 * Read the file a `read_file` gate targets so a `beforeReadFile` hook can inspect
 * its contents and deny (B4; Cursor sends `content` on the beforeReadFile stdin).
 * The read happens *after* the gate in normal flow, so we read it eagerly here —
 * only when a matching hook exists — and tolerate any error (missing file, binary,
 * permission) by returning undefined, which marshals to an empty `content`.
 */
async function readFileContentForGate(
  args: Record<string, unknown>,
  workspaceRoot: string | null,
): Promise<string | undefined> {
  const rawPath = args['path']
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined
  const abs = isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot ?? process.cwd(), rawPath)
  try {
    const content = await readFile(abs, 'utf-8')
    return content.length > MAX_READ_FILE_HOOK_CONTENT
      ? content.slice(0, MAX_READ_FILE_HOOK_CONTENT)
      : content
  } catch {
    return undefined
  }
}

/**
 * Run every dialect's command hooks that gate this tool call and reduce them to
 * a single decision. Returns `allow` when nothing matches. Firing goes through
 * the canonical `toolGate` registry event so this is exactly the path B1–B4 and
 * later phases extend — the adapters are the only dialect-aware code.
 */
export async function runToolGateHooks(
  check: ToolGateCheck,
  opts: DialectDiscoverOpts & { signal?: AbortSignal; agentSession?: AgentSessionInfo },
): Promise<HookGateDecision> {
  const payload: HookEventPayloads['toolGate'] = {
    toolName: check.toolName,
    input: asRecord(check.args),
  }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  const [cursorHooks, claudeHooks] = await Promise.all([
    cursorToolGateHooks(payload, discoverOpts),
    claudeToolGateHooks(payload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...claudeHooks]
  if (hooks.length === 0) return { permission: 'allow' }

  // Only now that a hook actually gates this read do we pay for the file read
  // (B4) — a redaction/secret-detection hook needs the bytes to decide.
  if (check.toolName === 'read_file') {
    const fileContent = await readFileContentForGate(payload.input, opts.workspaceRoot)
    if (fileContent !== undefined) payload.fileContent = fileContent
  }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const { outcomes } = await registry.emit('toolGate', payload, {
    runCommandHook: createCommandHookRunner(),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })
  const merged = mergeBlockingOutcomes(outcomes)

  // A hook `haltRun` (`continue: false`) blocks the action for the gate.
  const denied = merged.decision === 'deny' || merged.haltRun !== undefined
  const permission: HookGatePermission = denied
    ? 'deny'
    : merged.decision === 'ask'
      ? 'ask'
      : 'allow'
  return {
    permission,
    ...(merged.agentMessage !== undefined ? { agentMessage: merged.agentMessage } : {}),
    ...(merged.userMessage !== undefined ? { userMessage: merged.userMessage } : {}),
  }
}
