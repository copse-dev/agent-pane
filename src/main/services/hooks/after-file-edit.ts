// afterFileEdit orchestration (B2) — fires the canonical `afterFileEdit` event
// after a file edit lands on disk at the diff-queue / write-tool site.
//
// Same shape as `before-submit-prompt.ts` and `tool-gate.ts`: the fire site
// (diff-queue.ts, after a successful write) calls {@link runAfterFileEditHooks}
// with the edited file's absolute path; we discover the matching Cursor command
// hooks (applying their optional path/glob matcher), register them on a fresh
// registry, and fire `afterFileEdit` through the shared
// registry → runner → adapter seam.
//
// **Blocking by default (decision 2).** afterFileEdit hooks are formatters /
// accounting scripts, so the fire site *awaits* them: a formatter finishes
// rewriting the file before the agent proceeds. Cursor's afterFileEdit is a
// notification — it "cannot block the agent or return data" — so no hook here
// produces a control-flow decision; we fire and await purely for the side
// effect (and the always-on spine record).
//
// **Async opt-in — now honoured (F1 + C1).** The event carries `asyncOptIn:
// true` in the catalogue (decision 2). B2 wired blocking-only because no wired
// dialect could express per-hook async; F1's Copse dialect adds an `async: true`
// field and C1 landed the detached executor, so this fire site now **partitions**
// the discovered hooks: `blocking` hooks (Cursor's — always blocking — plus
// Copse hooks without `async`) are awaited (formatters), while Copse
// `async: true` hooks are dispatched detached through the shared
// {@link AsyncHookDispatcher} via `emitAsync` and never awaited (decision 3).
// A detached afterFileEdit observer's `queueMessage` routes through the pending-
// message queue (decision 4). The detached dispatch's thread / epoch are derived
// from the agent-session identity (the same convention `subagent.ts` uses).
//
// Cursor + Copse (F1) declare an `afterFileEdit` hook (wired here); Claude has no
// post-edit equivalent, so no Claude hooks participate — matching the vendor audit.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorAfterFileEditHooks } from './cursor-adapter.ts'
import { copseAfterFileEditHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { withRunDeadlinePaused } from './run-deadline.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/** What the diff-queue / write-tool fire site learns from the afterFileEdit hooks. */
export interface AfterFileEditResult {
  /**
   * How many afterFileEdit hooks matched this path and were run — the blocking
   * hooks (awaited) plus the async hooks (dispatched detached, F1 + C1).
   * afterFileEdit is notification-only, so there is no decision to surface — the
   * count is enough for the fire site to know work happened and for tests to
   * assert the event fired.
   */
  ran: number
  /**
   * How many of `ran` were dispatched **detached** (Copse `async: true`, F1).
   * Zero when no async afterFileEdit hook matched — the pre-F1 blocking-only path.
   */
  async: number
  /**
   * Resolves when the dispatched **async** afterFileEdit hooks have finished —
   * **a test affordance only**, never awaited in production (decision 3, no
   * drain barrier). Resolves immediately when none were async.
   */
  settled: Promise<void>
}

/** Options the diff-queue / write-tool fire site passes to {@link runAfterFileEditHooks}. */
export type RunAfterFileEditHooksOpts = DialectDiscoverOpts & {
  signal?: AbortSignal
  agentSession?: AgentSessionInfo
  /** Detached executor for async opt-in hooks; defaults to the shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's `afterFileEdit` command hooks whose matcher
 * covers `filePath`, awaiting each (blocking by default — decision 2). Returns
 * `{ ran: 0 }` when nothing matches. Firing goes through the canonical
 * `afterFileEdit` registry event, so this is exactly the seam later phases
 * extend — the adapters are the only dialect-aware code.
 *
 * `filePath` is the **absolute** path of the edited file (the canonical payload
 * shape); the adapter's matcher derives the workspace-relative form for globs.
 */
export async function runAfterFileEditHooks(
  filePath: string,
  opts: RunAfterFileEditHooksOpts,
): Promise<AfterFileEditResult> {
  const payload: HookEventPayloads['afterFileEdit'] = { filePath }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  // Cursor (always blocking) + Copse (F1, split by `async`) declare a post-edit
  // hook; Claude has none.
  const [cursorHooks, copseHooks] = await Promise.all([
    cursorAfterFileEditHooks(payload, discoverOpts),
    copseAfterFileEditHooks(payload, discoverOpts),
  ])
  const blockingHooks = [...cursorHooks, ...copseHooks.blocking]
  const asyncHooks = copseHooks.async
  if (blockingHooks.length === 0 && asyncHooks.length === 0) {
    return { ran: 0, async: 0, settled: Promise.resolve() }
  }

  // Blocking dispatch: `emit` awaits every command hook (decision 2). We ignore
  // the outcomes — afterFileEdit is notification-only, so there is no decision to
  // act on and the edit has already landed. H4 (decision 13): pause the run's
  // idle deadline while a (blocking) formatter hook runs so a slow formatter does
  // not advance the idle clock.
  if (blockingHooks.length > 0) {
    const registry = new HookRegistry()
    for (const hook of blockingHooks) registry.registerCommand(hook)
    await withRunDeadlinePaused(opts.agentSession?.conversationId, () =>
      registry.emit('afterFileEdit', payload, {
        runCommandHook: createCommandHookRunner(),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
      }),
    )
  }

  // Async opt-in dispatch (Copse `async: true`, F1 + C1): detached, never awaited
  // (decision 3). Thread + epoch are derived from the agent-session identity, the
  // same convention `subagent.ts` uses for its detached dispatch. A `queueMessage`
  // an async observer returns routes through the pending-message queue (decision 4).
  let settled = Promise.resolve()
  if (asyncHooks.length > 0) {
    const registry = new HookRegistry()
    for (const hook of asyncHooks) registry.registerCommand(hook)
    const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()
    const threadId = opts.agentSession?.conversationId || 'afterFileEdit'
    const turnTreeId = asTurnTreeId(opts.agentSession?.generationId || threadId)
    registry.emitAsync('afterFileEdit', payload, {
      dispatcher,
      threadId,
      turnTreeId,
      runCommandHook: createCommandHookRunner(),
      onAsyncOutcome: hookQueueOutcomeSink(threadId),
      ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
    })
    settled = dispatcher.whenIdle(threadId)
  }

  return { ran: blockingHooks.length + asyncHooks.length, async: asyncHooks.length, settled }
}
