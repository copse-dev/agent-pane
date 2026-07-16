// Host-side command-hook runner — the concrete spawn seam (A1).
//
// `packages/agent` defines the executor contract (`CommandHookRunner`,
// `CommandHook`, `CommandHookResult`) and stays Electron-free; the *concrete*
// process spawn, sandboxing, stdin/stdout marshalling, per-event exit-code
// tables and per-dialect failure resolution live here in `src/main`
// (execution-guidance rule 4). This is the module the app injects into
// `HookContext.runCommandHook`.
//
// A1 only establishes the seam. The real spawn is built by A2's dialect
// adapters — they own discovery, wire marshalling in both directions, matchers,
// and the exit-code tables that decide `failed`/`failureMode` (decision 9). Until
// then this runner is deliberately a not-yet-wired stub: it throws so a
// premature caller is loud rather than silently allowing an ungated action.
// A1 wires no fire sites, so nothing invokes it yet; the registry's defer-to-
// dialect safety net (`commandRunnerCrashResult`) means even a stray call can
// never fail-hard the harness.
import type { CommandHookRunner } from '@copse/agent/hooks/command-executor.ts'

/**
 * Thrown by the A1 stub runner. A2 replaces the runner body with a real spawn;
 * this exists so the not-yet-wired state is explicit rather than a silent no-op.
 */
export class CommandHookRunnerNotWiredError extends Error {
  readonly hookId: string
  readonly event: string

  constructor(hookId: string, event: string) {
    super(
      `command hook execution is not wired yet (A2 dialect adapters own the spawn): ` +
        `"${hookId}" for event "${event}"`,
    )
    this.name = 'CommandHookRunnerNotWiredError'
    this.hookId = hookId
    this.event = event
  }
}

/**
 * Build the host command-hook runner injected into `HookContext.runCommandHook`.
 * A1 ships the seam; A2 fills in the dialect adapters (Cursor / Claude / Copse)
 * that spawn the process, marshal the wire shape, and resolve per-dialect failure
 * semantics (decision 9) before returning a normalized {@link CommandHookResult}.
 */
export function createCommandHookRunner(): CommandHookRunner {
  return {
    run(hook): Promise<never> {
      return Promise.reject(new CommandHookRunnerNotWiredError(hook.id, hook.event))
    },
  }
}
