// beforeSubmitPrompt orchestration (B1) — fires the canonical `beforeSubmitPrompt`
// event on the compose path, before `agent:run` starts the agent turn.
//
// Same shape as `tool-gate.ts`: the compose path calls
// {@link runBeforeSubmitPromptHooks} with the composed prompt; we discover the
// matching command hooks from each dialect adapter, register them on a fresh
// registry, and fire `beforeSubmitPrompt` through the shared
// registry → runner → adapter seam. A hook's `continue: false` normalizes to
// `haltRun`, which we surface as a blocked submit (the turn never starts) and
// carry the hook's `user_message` for surfacing.
//
// Cursor + Copse (F1) declare a `beforeSubmitPrompt` hook (wired here); Claude
// has no compose-path equivalent, so no Claude hooks participate — matching the
// vendor audit in docs/plans/hooks-and-feature-packs.md.
import { HookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import { buildInjectedContextBlock } from '@copse/agent/hooks/inject-context.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorBeforeSubmitPromptHooks } from './cursor-adapter.ts'
import { copseBeforeSubmitPromptHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { withRunDeadlinePaused } from './run-deadline.ts'

/** The decision reduced from the compose-path `beforeSubmitPrompt` hooks. */
export interface BeforeSubmitPromptDecision {
  /** True when a hook halted the submit (`continue: false`) — the turn must not start. */
  blocked: boolean
  /** Message the hook wants shown to the user (carried on halt, B1 acceptance). */
  userMessage?: string
  /** Message a hook wants fed to the model, if any. */
  agentMessage?: string
  /** The halt reason, when a hook halted (defaults to `userMessage`). */
  reason?: string
  /**
   * Context a hook injected into the current turn (H2), built into the final
   * system-reminder block (10k-capped). Present only when the submit proceeds
   * (`blocked: false`) and a hook returned `additionalContext`; the compose path
   * folds it into the turn's system message alongside the `turnStart` steering.
   */
  injectContext?: string
}

/**
 * Discover + fire every dialect's `beforeSubmitPrompt` command hooks and reduce
 * them to a single decision. Returns `{ blocked: false }` when nothing matches.
 * Firing goes through the canonical `beforeSubmitPrompt` registry event, so this
 * is exactly the seam later phases extend — the adapters are the only
 * dialect-aware code.
 */
export async function runBeforeSubmitPromptHooks(
  prompt: string,
  opts: DialectDiscoverOpts & { signal?: AbortSignal; agentSession?: AgentSessionInfo },
): Promise<BeforeSubmitPromptDecision> {
  const payload: HookEventPayloads['beforeSubmitPrompt'] = { prompt }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  // Cursor + Copse declare a compose-path hook; Claude has none.
  const [cursorHooks, copseHooks] = await Promise.all([
    cursorBeforeSubmitPromptHooks(payload, discoverOpts),
    copseBeforeSubmitPromptHooks(payload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...copseHooks]
  if (hooks.length === 0) return { blocked: false }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  // H4 (decision 13): pause the run's idle deadline while the blocking hooks are
  // awaited. On the compose path the run's deadline usually is not registered
  // yet (it is created after this fires), so this is a transparent pass-through
  // there; it still holds when a compose-path hook runs mid-session.
  const { outcomes } = await withRunDeadlinePaused(opts.agentSession?.conversationId, () =>
    registry.emit('beforeSubmitPrompt', payload, {
      runCommandHook: createCommandHookRunner(),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
    }),
  )
  const merged = mergeBlockingOutcomes(outcomes)

  // `continue: false` maps to `haltRun`; a `deny` decision would too, though the
  // Cursor beforeSubmitPrompt contract only speaks `continue`.
  const blocked = merged.haltRun !== undefined || merged.decision === 'deny'
  // H2: injected context only applies when the submit proceeds — a halt drops
  // the turn, so there is nothing to inject into.
  const injectContext = blocked ? undefined : buildInjectedContextBlock(merged.injectContext)
  return {
    blocked,
    ...(merged.userMessage !== undefined ? { userMessage: merged.userMessage } : {}),
    ...(merged.agentMessage !== undefined ? { agentMessage: merged.agentMessage } : {}),
    ...(merged.haltRun !== undefined ? { reason: merged.haltRun.reason } : {}),
    ...(injectContext !== undefined ? { injectContext } : {}),
  }
}
