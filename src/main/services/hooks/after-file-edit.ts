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
// **Async opt-in is deferred, honestly.** The event carries `asyncOptIn: true`
// in the catalogue (decision 2), but no wired dialect can express per-hook async
// yet: Cursor's schema has no async flag, and the Copse dialect's `async` field
// (F1) plus the detached executor (C1) have not landed. B2 therefore wires
// blocking-only; the per-hook async opt-in lands with F1 + C1. See
// docs/plans/hooks-and-feature-packs.md (B2 row).
//
// Cursor declares an `afterFileEdit` hook (wired here); Claude has no post-edit
// equivalent, so no Claude hooks participate — matching the vendor audit.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorAfterFileEditHooks } from './cursor-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'

/** What the diff-queue / write-tool fire site learns from the afterFileEdit hooks. */
export interface AfterFileEditResult {
  /**
   * How many afterFileEdit hooks matched this path and were run (awaited).
   * afterFileEdit is notification-only, so there is no decision to surface — the
   * count is enough for the fire site to know work happened and for tests to
   * assert the event fired.
   */
  ran: number
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
  opts: DialectDiscoverOpts & { signal?: AbortSignal },
): Promise<AfterFileEditResult> {
  const payload: HookEventPayloads['afterFileEdit'] = { filePath }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  // Cursor is the only dialect with a post-edit hook; Claude has none.
  const hooks = await cursorAfterFileEditHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0 }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  // Blocking dispatch: `emit` awaits every command hook (decision 2). We ignore
  // the outcomes — Cursor afterFileEdit is notification-only, so there is no
  // decision to act on and the edit has already landed.
  await registry.emit('afterFileEdit', payload, {
    runCommandHook: createCommandHookRunner(),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  return { ran: hooks.length }
}
