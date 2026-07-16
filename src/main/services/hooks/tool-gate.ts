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
import { HookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
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
}

export interface ToolGateCheck {
  toolName: string
  args: unknown
}

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? { ...(args as Record<string, unknown>) } : {}
}

/**
 * Run every dialect's command hooks that gate this tool call and reduce them to
 * a single decision. Returns `allow` when nothing matches. Firing goes through
 * the canonical `toolGate` registry event so this is exactly the path B1–B4 and
 * later phases extend — the adapters are the only dialect-aware code.
 */
export async function runToolGateHooks(
  check: ToolGateCheck,
  opts: DialectDiscoverOpts & { signal?: AbortSignal },
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

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const { outcomes } = await registry.emit('toolGate', payload, {
    runCommandHook: createCommandHookRunner(),
    ...(opts.signal ? { signal: opts.signal } : {}),
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
  }
}
