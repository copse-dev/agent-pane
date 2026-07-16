// subagent lifecycle orchestration (D1) — fires the canonical `subagentStart`
// (blocking spawn gate) and `subagentStop` (detached completion) events.
//
// `subagentStart` mirrors `before-submit-prompt.ts` (blocking decision):
// discover the matching Cursor command hooks (matcher on subagent type),
// register them on a fresh registry, fire through the shared
// registry → runner → adapter seam, and reduce to a single decision. A `deny`
// (Cursor's `permission: deny`, or `ask`, which the vendor treats as deny)
// prevents the spawn — the subagent loop never runs.
//
// `subagentStop` mirrors `stop.ts` (detached async, decision 3): dispatched
// through the shared {@link AsyncHookDispatcher} via `emitAsync` and **never
// awaited**. A `followup_message` (consumed only on `status: completed`) is
// carried out of the runner as a `queueMessage` and forwarded to the pending-
// message queue (C2) — where the C3 continuation budget gates it at drain time
// — via the same `onAsyncOutcome` sink `stop.ts` uses. No bespoke follow-up
// protocol (decision 4).
//
// The two callbacks are injected into `runSubagent` (`packages/agent`) so that
// package stays Electron-free (execution-guidance rule 4): the pure loop calls
// them, this host module owns discovery / dialects / dispatch.
//
// Cursor declares `subagentStart` / `subagentStop` (wired here); Claude has no
// subagent-lifecycle hook, so no Claude hooks participate — matching the vendor
// audit in docs/plans/hooks-and-feature-packs.md.
import { errorMessage } from '@shared/errors.ts'
import { HookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { RunSubagentOptions, SubagentStartDecision } from '@copse/agent/run-subagent.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorSubagentStartHooks, cursorSubagentStopHooks } from './cursor-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'
import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from '../security/workspace-trust.ts'
import { currentAgentSessionInfo } from './agent-session.ts'

/** The decision reduced from the `subagentStart` gate hooks. */
export interface SubagentStartHookDecision {
  /** True when a hook denied the spawn (`permission: deny`/`ask`, or a halt). */
  denied: boolean
  /** Message a hook wants fed to the parent agent, if any. */
  agentMessage?: string
  /** Message a hook wants shown to the user (hook card), if any. */
  userMessage?: string
}

/**
 * Discover + fire every dialect's `subagentStart` command hooks (matcher on
 * subagent type) and reduce them to a single decision. Returns
 * `{ denied: false }` when nothing matches, so the default spawn path is
 * unchanged. Firing goes through the canonical `subagentStart` registry event.
 */
export async function runSubagentStartHooks(
  subagentType: string,
  opts: DialectDiscoverOpts & { signal?: AbortSignal; agentSession?: AgentSessionInfo },
): Promise<SubagentStartHookDecision> {
  const payload: HookEventPayloads['subagentStart'] = { subagentType }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await cursorSubagentStartHooks(payload, discoverOpts)
  if (hooks.length === 0) return { denied: false }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const { outcomes } = await registry.emit('subagentStart', payload, {
    runCommandHook: createCommandHookRunner(),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })
  const merged = mergeBlockingOutcomes(outcomes)

  // A `deny` decision (Cursor `permission: deny`/`ask`) or a `haltRun` blocks the
  // spawn. `ask` is normalized to `deny` by the adapter (vendor contract).
  const denied = merged.decision === 'deny' || merged.haltRun !== undefined
  return {
    denied,
    ...(merged.agentMessage !== undefined ? { agentMessage: merged.agentMessage } : {}),
    ...(merged.userMessage !== undefined ? { userMessage: merged.userMessage } : {}),
  }
}

/** What the subagent-completion fire site learns from the `subagentStop` hooks. */
export interface SubagentStopResult {
  /** How many `subagentStop` hooks matched and were dispatched (detached). */
  ran: number
  /**
   * Resolves when the dispatched hooks have finished — **a test affordance
   * only**, never awaited in production (decision 3, no drain barrier).
   */
  settled: Promise<void>
}

/** Options the subagent-completion fire site passes to {@link runSubagentStopHooks}. */
export type RunSubagentStopHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's `subagentStop` command hooks, **dispatched
 * through the detached async executor** (C1, decision 3 — never awaited). A
 * `followup_message` is carried out of the runner as a `queueMessage` and
 * forwarded to the pending-message queue via `onAsyncOutcome`, where the C3
 * budget gates it at drain time (decision 5). Returns `{ ran: 0 }` when nothing
 * matches.
 */
export async function runSubagentStopHooks(
  payload: HookEventPayloads['subagentStop'],
  opts: RunSubagentStopHooksOpts,
): Promise<SubagentStopResult> {
  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await cursorSubagentStopHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  registry.emitAsync('subagentStop', payload, {
    dispatcher,
    threadId: opts.threadId,
    turnTreeId: opts.turnTreeId,
    runCommandHook: createCommandHookRunner(),
    // A `followup_message` outcome lands in the renderer's pending queue via this
    // sink (decision 4). The C3 budget consumes it at drain time; a stale-epoch
    // send-now is downgraded to held on the renderer side (decision 16).
    onAsyncOutcome: hookQueueOutcomeSink(opts.threadId),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length, settled: dispatcher.whenIdle(opts.threadId) }
}

/**
 * Build the `subagentStart` / `subagentStop` callbacks a subagent host wrapper
 * injects into {@link RunSubagentOptions}, so the pure loop can gate + notify
 * without importing app services. Gated behind `cursorHooksEnabled` (default
 * off) at build time — like every other hook fire site — so a disabled feature
 * returns no callbacks and the spawn path is byte-identical to before D1.
 *
 * The subagent's resolved model (B4) is threaded onto the wire payload: the
 * agent-session `model` / `subagent_model` is `usageModel` (the model the
 * subagent actually runs, including a local→cloud fallback). Conversation /
 * generation ids stay the parent run's ambient identity.
 */
export function subagentHookCallbacks(opts: {
  usageModel?: string
}): Pick<RunSubagentOptions, 'onSubagentStart' | 'onSubagentStop'> {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return {}

  // The subagent's resolved model rides on the agent-session identity (B4). When
  // no usageModel is provided we fall back to the ambient active-run model.
  const buildSession = (): AgentSessionInfo =>
    currentAgentSessionInfo(opts.usageModel !== undefined ? { model: opts.usageModel } : {})

  return {
    onSubagentStart: async (subagentType): Promise<SubagentStartDecision> => {
      const workspaceRoot = getWorkspaceRoot()
      const decision = await runSubagentStartHooks(subagentType, {
        workspaceRoot,
        projectTrusted: isWorkspaceTrusted(workspaceRoot),
        agentSession: buildSession(),
      })
      return {
        denied: decision.denied,
        ...(decision.agentMessage !== undefined ? { agentMessage: decision.agentMessage } : {}),
        ...(decision.userMessage !== undefined ? { userMessage: decision.userMessage } : {}),
      }
    },
    onSubagentStop: (subagentType, status): void => {
      const workspaceRoot = getWorkspaceRoot()
      const agentSession = buildSession()
      const threadId = agentSession.conversationId || 'subagent'
      // Epoch: the parent run's turn/generation id (the per-submission stand-in),
      // falling back to the thread id — the same convention `fireStopHook` uses.
      const turnTreeId = asTurnTreeId(agentSession.generationId || threadId)
      void runSubagentStopHooks(
        { subagentType, status },
        {
          threadId,
          turnTreeId,
          workspaceRoot,
          projectTrusted: isWorkspaceTrusted(workspaceRoot),
          agentSession,
        },
      ).catch((err: unknown) => {
        console.warn('[hooks] subagentStop dispatch error:', errorMessage(err))
      })
    },
  }
}
