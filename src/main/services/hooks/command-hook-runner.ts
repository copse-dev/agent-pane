// Host-side command-hook runner — the concrete spawn seam (A1 stub → A2 real).
//
// `packages/agent` defines the executor contract (`CommandHookRunner`,
// `CommandHook`, `CommandHookResult`) and stays Electron-free; the *concrete*
// process spawn, dialect wire marshalling both directions, per-event exit-code
// tables, and per-dialect failure resolution live here (execution-guidance rule
// 4). This is the module the app injects into `HookContext.runCommandHook`, so
// registry command hooks actually spawn.
//
// The runner is dialect-agnostic: it looks a hook's `dialect` up in the adapter
// registry and delegates marshalling + interpretation. The only failure policy
// it owns is decision 9's uniform resolution — a `failed` run becomes `deny`
// under `onFailure: closed` (Cursor `failClosed: true`) or a no-op under
// `onFailure: open` (the vendor default). A dialect that treats a signal as a
// *decision* (Claude exit-2 deny) reports it as a non-failed outcome, so it is
// never routed through this resolution.
import type {
  CommandHookRunner,
  CommandHookResult,
  CommandHook,
} from '@copse/agent/hooks/command-executor.ts'
import type {
  HookContext,
  HookEventName,
  HookEventPayloads,
} from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome } from '@copse/agent/hooks/hook-outcome.ts'
import { recordCommandHookRun } from '../hook-run-recorder.ts'
import { getDialectAdapter } from './dialect-registry.ts'
import { spawnHookProcess } from './hook-spawn.ts'
import type { DialectInterpretation } from './dialect-adapter.ts'

/** No usable response — the action proceeds (a command hook is never fail-hard). */
const ABSTAIN: CommandHookResult = { outcome: null, failed: false }

function isToolGatePayload(payload: unknown): payload is HookEventPayloads['toolGate'] {
  return (
    typeof payload === 'object' && payload !== null && 'toolName' in payload && 'input' in payload
  )
}

/**
 * Resolve a `failed` run to its outcome per the hook's `onFailure` (decision 9):
 * `closed` blocks (Cursor `failClosed: true`), `open` abstains (vendor default).
 */
function resolveFailure(
  hook: CommandHook,
  interpretation: DialectInterpretation,
): CommandHookResult {
  const outcome: BlockingHookOutcome | null =
    hook.onFailure === 'closed'
      ? {
          decision: 'deny',
          agentMessage:
            interpretation.runtimeError !== undefined
              ? `hook "${hook.id}" ${interpretation.runtimeError} — blocked by failClosed`
              : `hook "${hook.id}" failed — blocked by failClosed`,
        }
      : null
  return { outcome, failed: true, failureMode: hook.onFailure }
}

/**
 * Build the host command-hook runner injected into `HookContext.runCommandHook`.
 * A2 wires only the `toolGate` event (the permission gate); other canonical
 * events land their fire sites in later phases and register no command hooks yet.
 */
export function createCommandHookRunner(): CommandHookRunner {
  return {
    async run<E extends HookEventName>(
      hook: CommandHook<E>,
      payload: HookEventPayloads[E],
      context: HookContext,
    ): Promise<CommandHookResult> {
      // A2 only wires toolGate command hooks; anything else abstains cleanly
      // until its phase wires the fire site (never a hard failure).
      if (hook.event !== 'toolGate' || !isToolGatePayload(payload)) return ABSTAIN

      const adapter = getDialectAdapter(hook.dialect)
      if (!adapter) return ABSTAIN

      const request = adapter.marshalToolGateRequest(hook, payload)
      // A null request means the hook does not apply to this tool — abstain.
      if (request === null) return ABSTAIN

      const spawn = await spawnHookProcess(hook.command, request, {
        cwd: hook.cwd ?? process.cwd(),
        ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })

      const interpretation = adapter.interpretToolGate(spawn, payload)

      // Always-on spine recording (decision 6): one hook_run line per execution,
      // raw stdout AND stderr as blobs, next to the normalized decision.
      recordCommandHookRun({
        event: interpretation.spineEvent,
        hookId: hook.id,
        startedAt: spawn.startedAt,
        durationMs: spawn.durationMs,
        exitCode: spawn.exitCode,
        parseOk: interpretation.parseOk,
        decision: interpretation.spineDecision,
        stdout: spawn.stdout,
        stderr: spawn.stderr,
      })

      if (interpretation.failed) {
        if (interpretation.runtimeError !== undefined) {
          adapter.recordRuntimeFailure(
            interpretation.spineEvent,
            hook.id,
            interpretation.runtimeError,
          )
        }
        return resolveFailure(hook, interpretation)
      }

      return { outcome: interpretation.outcome, failed: false }
    },
  }
}
