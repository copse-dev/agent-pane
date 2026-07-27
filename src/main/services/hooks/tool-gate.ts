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
import { buildInjectedContextBlock } from '@copse/agent/hooks/inject-context.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorToolGateHooks } from './cursor-adapter.ts'
import { claudeToolGateHooks } from './claude-adapter.ts'
import { copseToolGateHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { withRunDeadlinePaused } from './run-deadline.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** A permission-style verdict reduced from the tool-gate hooks. */
export type HookGatePermission = 'allow' | 'deny' | 'ask'

export interface HookGateDecision {
  permission: HookGatePermission
  /** Message a denying/asking hook wants surfaced to the agent, if any. */
  agentMessage?: string
  /** Message a denying/asking hook wants shown to the user, if any. */
  userMessage?: string
  /**
   * The tool input after the sequential `updatedInput` pipeline rewrote it (H1),
   * present only when at least one hook returned `updatedInput`. It is the
   * **final** threaded input (each hook saw the prior rewrite), so the caller
   * (`permission-gate`) applies it and **re-runs the policy matrix**
   * (`analyzeShellCommand` / `decideShellPermission`) on it before allowing the
   * tool — a rewrite is never applied without re-analysis (security-critical).
   */
  updatedInput?: Record<string, unknown>
  /**
   * Context a blocking hook injected into the current turn (H2), already built
   * into the final system-reminder block (10k-capped, with a truncation note on
   * overflow). Present only when the gate allows (or an `ask` is approved) and a
   * hook returned `injectContext` — a deny drops the tool, so there is nothing
   * to inject into. The caller appends this to the tool's result so the model
   * reads it in the current turn.
   */
  injectContext?: string
  /**
   * A hook asked to halt the whole run (`continue: false`, H3 / decision 12).
   * This is stronger than the `deny` it also produces: `deny` blocks *this* tool
   * call, while `haltRun` stops the current turn through the run's abort path.
   * The caller (`permission-gate`) routes it to the abort path, attributed to
   * `hookId`. Present only when a hook returned `haltRun`.
   */
  haltRun?: { reason: string; hookId: string }
}

export interface ToolGateCheck {
  toolName: string
  args: unknown
}

function asRecord(args: unknown): Record<string, unknown> {
  return isRecord(args) ? { ...args } : {}
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
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  const [cursorHooks, claudeHooks, copseHooks] = await Promise.all([
    cursorToolGateHooks(payload, discoverOpts),
    claudeToolGateHooks(payload, discoverOpts),
    copseToolGateHooks(payload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...claudeHooks, ...copseHooks]
  if (hooks.length === 0) return { permission: 'allow' }

  // Only now that a hook actually gates this read do we pay for the file read
  // (B4) — a redaction/secret-detection hook needs the bytes to decide.
  if (check.toolName === 'read_file') {
    const fileContent = await readFileContentForGate(
      payload.input,
      opts.executionRoot ?? opts.workspaceRoot,
    )
    if (fileContent !== undefined) payload.fileContent = fileContent
  }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  // `registry.emit` runs the hooks in registration order and threads each
  // hook's `updatedInput` into `payload.input` for the next hook (the H1
  // sequential pipeline lives in the registry so both function and command
  // hooks participate), so `payload.input` here is the *final* rewritten input.
  // H4 (decision 13): pause the run's idle deadline while the blocking hooks are
  // awaited, the same way tool execution does — a slow gate hook (up to its
  // per-dialect timeout) must not advance the idle clock.
  const { outcomes } = await withRunDeadlinePaused(opts.agentSession?.conversationId, () =>
    registry.emit('toolGate', payload, {
      runCommandHook: createCommandHookRunner(),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
    }),
  )
  const merged = mergeBlockingOutcomes(outcomes)

  // A hook `haltRun` (`continue: false`) blocks the action for the gate.
  const denied = merged.decision === 'deny' || merged.haltRun !== undefined
  const permission: HookGatePermission = denied
    ? 'deny'
    : merged.decision === 'ask'
      ? 'ask'
      : 'allow'
  // H3: a `haltRun` does more than deny this tool — it stops the current turn
  // through the abort path. Attribute it to the first hook that halted (the
  // merge takes the first `haltRun`, decision 12) so the abort + spine line name
  // the responsible hook.
  const haltRun =
    merged.haltRun !== undefined
      ? {
          reason: merged.haltRun.reason,
          hookId: outcomes.find((o) => o.outcome.haltRun !== undefined)?.hookId ?? check.toolName,
        }
      : undefined
  // A rewrite is surfaced only when the pipeline actually produced one; the
  // value is the final threaded `payload.input`, not just the last hook's delta,
  // so the caller re-runs policy on the complete rewritten input.
  const rewritten = merged.updatedInput !== undefined
  // H2: a hook's `injectContext` becomes the current-turn system-reminder block
  // (10k-capped). Only meaningful when the tool proceeds — a `deny` drops the
  // tool and its result, so we never build a block for a denied gate.
  const injectContext = denied ? undefined : buildInjectedContextBlock(merged.injectContext)
  return {
    permission,
    ...(merged.agentMessage !== undefined ? { agentMessage: merged.agentMessage } : {}),
    ...(merged.userMessage !== undefined ? { userMessage: merged.userMessage } : {}),
    ...(rewritten ? { updatedInput: payload.input } : {}),
    ...(injectContext !== undefined ? { injectContext } : {}),
    ...(haltRun !== undefined ? { haltRun } : {}),
  }
}
