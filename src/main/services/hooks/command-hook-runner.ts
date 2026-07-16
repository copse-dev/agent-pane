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
import { recordCommandHookRun, type HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { hookRecursionGuardTripped } from './hook-depth.ts'
import { getDialectAdapter } from './dialect-registry.ts'
import { spawnHookProcess, type HookSpawnResult } from './hook-spawn.ts'
import { getSessionEnv } from './session-env.ts'
import type { DialectAdapter, DialectInterpretation } from './dialect-adapter.ts'

/** No usable response — the action proceeds (a command hook is never fail-hard). */
const ABSTAIN: CommandHookResult = { outcome: null, failed: false }

function isToolGatePayload(payload: unknown): payload is HookEventPayloads['toolGate'] {
  return (
    typeof payload === 'object' && payload !== null && 'toolName' in payload && 'input' in payload
  )
}

function isBeforeSubmitPromptPayload(
  payload: unknown,
): payload is HookEventPayloads['beforeSubmitPrompt'] {
  return typeof payload === 'object' && payload !== null && 'prompt' in payload
}

function isAfterFileEditPayload(payload: unknown): payload is HookEventPayloads['afterFileEdit'] {
  return typeof payload === 'object' && payload !== null && 'filePath' in payload
}

function isStopPayload(payload: unknown): payload is HookEventPayloads['stop'] {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'status' in payload &&
    !('subagentType' in payload)
  )
}

function isSubagentStartPayload(payload: unknown): payload is HookEventPayloads['subagentStart'] {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'subagentType' in payload &&
    !('status' in payload)
  )
}

function isSubagentStopPayload(payload: unknown): payload is HookEventPayloads['subagentStop'] {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'subagentType' in payload &&
    'status' in payload
  )
}

function isAfterToolUsePayload(payload: unknown): payload is HookEventPayloads['afterToolUse'] {
  // Distinguished from `toolGate` (which has `toolName` + `input` but no
  // `isError`) by the `isError` observation field the post-tool payload carries.
  return (
    typeof payload === 'object' && payload !== null && 'toolName' in payload && 'isError' in payload
  )
}

function isSessionStartPayload(payload: unknown): payload is HookEventPayloads['sessionStart'] {
  return typeof payload === 'object' && payload !== null && 'firstTurn' in payload
}

function isBeforeDiffApplyPayload(
  payload: unknown,
): payload is HookEventPayloads['beforeDiffApply'] {
  // Shares `filePath` with `afterFileEdit`; the caller gates on `hook.event`
  // first, so distinguishing from the (applied-bearing) afterDiffApply is enough.
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'filePath' in payload &&
    !('applied' in payload)
  )
}

function isAfterDiffApplyPayload(payload: unknown): payload is HookEventPayloads['afterDiffApply'] {
  return (
    typeof payload === 'object' && payload !== null && 'filePath' in payload && 'applied' in payload
  )
}

function isPermissionDecisionPayload(
  payload: unknown,
): payload is HookEventPayloads['permissionDecision'] {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'toolName' in payload &&
    'decision' in payload
  )
}

function isPostTurnReviewPayload(payload: unknown): payload is HookEventPayloads['postTurnReview'] {
  return typeof payload === 'object' && payload !== null && 'issuesFound' in payload
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
 * Spawn one hook, interpret it via its dialect, record the spine line, and
 * resolve failures per `onFailure` — the shared execution path every wired
 * event uses. Only the marshalled `request` and the dialect `interpret` closure
 * differ per event; a null request means the hook does not apply (abstain).
 */
async function spawnInterpretResolve(
  hook: CommandHook,
  adapter: DialectAdapter,
  request: unknown,
  interpret: (spawn: HookSpawnResult) => DialectInterpretation,
  context: HookContext,
  recordingSnapshot: HookRunRecordingSnapshot | null | undefined,
): Promise<CommandHookResult> {
  if (request === null) return ABSTAIN

  // H4: propagate this session's `sessionStart` env into the hook process. Keyed
  // by the session id (`conversation_id` = thread id) on the agent-session info;
  // the store is empty until a `sessionStart` hook has populated it, so this is a
  // no-op outside an env-propagating session.
  const sessionId = context.agentSession?.conversationId
  const sessionEnv = sessionId ? getSessionEnv(sessionId) : undefined

  const spawn = await spawnHookProcess(hook.command, request, {
    cwd: hook.cwd ?? process.cwd(),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(sessionEnv ? { sessionEnv } : {}),
  })

  const interpretation = interpret(spawn)

  // Always-on spine recording (decision 6): one hook_run line per execution,
  // raw stdout AND stderr as blobs, next to the normalized decision. Detached
  // async hooks pass a `recordingSnapshot` captured at their fire site so the
  // line survives `endHookRunRecording` (decision 3); blocking hooks pass
  // `undefined` and record against the live context.
  recordCommandHookRun(
    {
      event: interpretation.spineEvent,
      hookId: hook.id,
      startedAt: spawn.startedAt,
      durationMs: spawn.durationMs,
      exitCode: spawn.exitCode,
      parseOk: interpretation.parseOk,
      decision: interpretation.spineDecision,
      stdout: spawn.stdout,
      stderr: spawn.stderr,
    },
    recordingSnapshot,
  )

  if (interpretation.failed) {
    if (interpretation.runtimeError !== undefined) {
      adapter.recordRuntimeFailure(interpretation.spineEvent, hook.id, interpretation.runtimeError)
    }
    return resolveFailure(hook, interpretation)
  }

  return {
    outcome: interpretation.outcome,
    failed: false,
    // Async follow-up (D1 subagentStop) rides through to the queue channel via
    // emitAsync's `onAsyncOutcome`; absent on every blocking-event run.
    ...(interpretation.queueMessage ? { queueMessage: interpretation.queueMessage } : {}),
    // Session env (H4 sessionStart): forwarded to `onAsyncOutcome` by emitAsync
    // and collected into the session env store; absent on every other run.
    ...(interpretation.sessionEnv ? { sessionEnv: interpretation.sessionEnv } : {}),
  }
}

/**
 * Build the host command-hook runner injected into `HookContext.runCommandHook`.
 * A2 wired the `toolGate` event (the permission gate); B1 adds
 * `beforeSubmitPrompt` (the compose path); B2 adds `afterFileEdit` (the
 * diff-queue / write-tool site); B3 adds `stop` (turn end / abort, dispatched
 * detached — decision 3); D1 adds `subagentStart` (blocking spawn gate, matcher
 * on subagent type) and `subagentStop` (detached completion, `followup_message`
 * routed to the queue channel); D2 adds `afterToolUse` (post-tool observation,
 * dispatched detached — the Cursor `afterShellExecution` / `afterMCPExecution`
 * flavors with a capped output snapshot). F2 adds the four Copse-native events —
 * `beforeDiffApply` (blocking diff-apply gate), `afterDiffApply` /
 * `permissionDecision` / `postTurnReview` (detached observations). Foreign
 * adapters (Cursor / Claude) declare no marshaller for those, so the runner
 * abstains for them. Other canonical events land their fire sites in later
 * phases and register no command hooks yet, so they abstain.
 */
export function createCommandHookRunner(opts?: {
  /**
   * Recording context captured synchronously at a detached fire site (`stop`,
   * `subagentStop`, …). When set, command-hook spine lines record against it so
   * they survive `endHookRunRecording` (decision 3/6). Omit for blocking hooks,
   * which record against the live context.
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
}): CommandHookRunner {
  const recordingSnapshot = opts?.recordingSnapshot
  return {
    async run<E extends HookEventName>(
      hook: CommandHook<E>,
      payload: HookEventPayloads[E],
      context: HookContext,
    ): Promise<CommandHookResult> {
      // Recursion guard (decision 5): if this Copse is itself running inside a
      // hook (`COPSE_HOOK_DEPTH` ≥ MAX), suppress all command-hook spawns so a
      // hook that re-enters Copse cannot drive an unbounded hook→Copse→hook
      // loop. Abstaining (never fail-hard) matches a command hook that returns
      // no decision — the action proceeds, one nested level breaks the loop.
      if (hookRecursionGuardTripped()) return ABSTAIN

      // Every wired agent-session event stamps the real conversation / generation
      // ids + running model onto its wire payload (B4); the host captures it at
      // the fire site and hands it through the context (opaque to packages/agent).
      const session = context.agentSession

      if (hook.event === 'toolGate' && isToolGatePayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        if (!adapter) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          adapter.marshalToolGateRequest(hook, payload, session),
          (spawn) => adapter.interpretToolGate(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'beforeSubmitPrompt' && isBeforeSubmitPromptPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        // A dialect with no compose-path hook (Claude) omits these — abstain.
        const marshal = adapter?.marshalBeforeSubmitPromptRequest?.bind(adapter)
        const interpret = adapter?.interpretBeforeSubmitPrompt?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'afterFileEdit' && isAfterFileEditPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalAfterFileEditRequest?.bind(adapter)
        const interpret = adapter?.interpretAfterFileEdit?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'stop' && isStopPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalStopRequest?.bind(adapter)
        const interpret = adapter?.interpretStop?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'subagentStart' && isSubagentStartPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalSubagentStartRequest?.bind(adapter)
        const interpret = adapter?.interpretSubagentStart?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'subagentStop' && isSubagentStopPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalSubagentStopRequest?.bind(adapter)
        const interpret = adapter?.interpretSubagentStop?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'afterToolUse' && isAfterToolUsePayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalAfterToolUseRequest?.bind(adapter)
        const interpret = adapter?.interpretAfterToolUse?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'sessionStart' && isSessionStartPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalSessionStartRequest?.bind(adapter)
        const interpret = adapter?.interpretSessionStart?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
          recordingSnapshot,
        )
      }

      if (hook.event === 'beforeDiffApply' && isBeforeDiffApplyPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalBeforeDiffApplyRequest?.bind(adapter)
        const interpret = adapter?.interpretBeforeDiffApply?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
        )
      }

      if (hook.event === 'afterDiffApply' && isAfterDiffApplyPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalAfterDiffApplyRequest?.bind(adapter)
        const interpret = adapter?.interpretAfterDiffApply?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
        )
      }

      if (hook.event === 'permissionDecision' && isPermissionDecisionPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalPermissionDecisionRequest?.bind(adapter)
        const interpret = adapter?.interpretPermissionDecision?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
        )
      }

      if (hook.event === 'postTurnReview' && isPostTurnReviewPayload(payload)) {
        const adapter = getDialectAdapter(hook.dialect)
        const marshal = adapter?.marshalPostTurnReviewRequest?.bind(adapter)
        const interpret = adapter?.interpretPostTurnReview?.bind(adapter)
        if (!adapter || !marshal || !interpret) return ABSTAIN
        return spawnInterpretResolve(
          hook,
          adapter,
          marshal(hook, payload, session),
          (spawn) => interpret(spawn, payload),
          context,
        )
      }

      // Unwired event (no fire site yet): abstain cleanly, never a hard failure.
      return ABSTAIN
    },
  }
}
