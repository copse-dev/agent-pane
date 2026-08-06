import { createHash, randomUUID } from 'node:crypto'
import type { LLMTool } from '@shared/types'
import type { HookRunRecord } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome } from '@copse/agent/hooks/hook-outcome.ts'
import type { FileToWrite } from '@shared/threads/fold.ts'
import {
  SPINE_SCHEMA_VERSION,
  toolsetBlobRef,
  type ContentRef,
  type SpineHookRunDecision,
  type SpineHookRunLine,
} from '@shared/threads/spine-schema.ts'
import { hookCardFromSpineLine, type HookCard } from '@shared/hooks/hook-card.ts'
import { fingerprintToolset, type ToolsetFingerprint } from '@shared/threads/toolset-fingerprint.ts'
import { safeJsonStringify } from '@shared/safe-json.ts'
import { appendHookRun } from './thread-store.ts'
import { storageGet } from './storage/storage.ts'

/**
 * Always-on spine recording of hook executions (decision 6 of
 * docs/plans/hooks-and-feature-packs.md). This module owns the *attribution
 * and persistence* half of the contract: the executors report what ran
 * (`packages/agent`'s registry via the injected `recordHookRun` sink; the
 * cursor-hooks command runner directly), and this module stamps the emitting
 * thread/turn/step plus the current toolset fingerprint and appends a
 * `hook_run` line — with raw stdout/stderr blobs for command hooks — to the
 * thread's `events.jsonl`.
 *
 * Recording is observability, never behavior: every failure path here degrades
 * to a warning, and executions with no active run context (e.g. unit tests
 * poking the permission gate directly) are skipped because there is no thread
 * directory to attribute them to.
 */

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

/** Keep spine lines small: error strings are summaries, not dumps. */
const MAX_ERROR_CHARS = 500

/**
 * Ceiling on a captured payload / outcome blob. The spine line stays a compact
 * summary (decision 6) and the bodies live in blobs, but a blob is still not a
 * dump ground: a 10 MB tool input or a runaway steering block is truncated with
 * a visible marker so the transcript's disk cost stays bounded and the reader
 * knows they are looking at a prefix. Raw command-hook stdout/stderr keep their
 * own (much larger) runner-side cap — those are the response channel itself.
 */
const MAX_CAPTURE_CHARS = 32_000

/** Truncate to {@link MAX_CAPTURE_CHARS}, marking the cut so it is never silent. */
function boundedCapture(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text
  const dropped = text.length - MAX_CAPTURE_CHARS
  return `${text.slice(0, MAX_CAPTURE_CHARS)}\n… [truncated ${String(dropped)} more chars]`
}

/**
 * Serialize a captured value for a blob, pretty-printed so the inspector shows
 * something a human can read. Returns null when the value cannot be serialized
 * (a cycle, a BigInt) — capture is observability, so an unserializable payload
 * costs the blob, never the hook run.
 */
function captureJson(value: unknown): string | null {
  try {
    const json = safeJsonStringify(value, 2)
    return json === undefined ? null : boundedCapture(json)
  } catch {
    return null
  }
}

interface HookRunRecordingContext {
  projectId: string
  threadId: string
  /** Generated per agent run; the "turn" half of decision 6's attribution. */
  turnId: string
  /** LLM-call index at emission time (0 = before the first call). */
  step: number
  /** Fingerprint of the toolset currently offered to the model, when known. */
  toolset: ToolsetFingerprint | null
}

let current: HookRunRecordingContext | null = null

/**
 * Live hook-card sink (decision 10). Set per-run by the agent service so a
 * `hook_run` spine append also emits a `hook_run` stream chunk, letting the
 * renderer show the hook-card family *as it runs* — the same card it would fold
 * from the spine on reload. Optional and best-effort: recording never depends on
 * a sink being present (observability, not behavior), and a throwing sink is
 * swallowed so a UI hiccup can't break a hook run.
 */
let liveSink: ((card: HookCard) => void) | null = null

/** Register the live hook-card sink for a run (cleared in the run's finally). */
export function setHookRunLiveSink(sink: (card: HookCard) => void): void {
  liveSink = sink
}

/** Clear the live hook-card sink (idempotent; only clears the given sink). */
export function clearHookRunLiveSink(sink: (card: HookCard) => void): void {
  if (liveSink === sink) liveSink = null
}

function emitLiveHookCard(line: SpineHookRunLine): void {
  if (!liveSink) return
  try {
    liveSink(hookCardFromSpineLine(line))
  } catch (err) {
    console.warn('[hook-run-recorder] live hook-card sink threw:', err)
  }
}

/**
 * Start attributing hook executions to an agent run. Resolves the project from
 * the active-project pointer (the same source the usage ledger uses); when no
 * project is active there is no thread directory to write to, so recording
 * stays off for the run.
 */
export function beginHookRunRecording(threadId: string): void {
  const projectId = storageGet('activeProjectId')
  if (typeof projectId !== 'string' || projectId.length === 0) {
    current = null
    return
  }
  current = { projectId, threadId, turnId: randomUUID(), step: 0, toolset: null }
}

/** Stop attributing (only if the context still belongs to this thread). */
export function endHookRunRecording(threadId: string): void {
  if (current?.threadId === threadId) current = null
}

/** Current run attribution for observability sinks (stream stats, etc.). */
export function getHookRunRecordingContext(): HookRunRecordingSnapshot | null {
  return current ? { ...current } : null
}

/** An opaque, by-value copy of the recording context for detached attribution. */
export type HookRunRecordingSnapshot = HookRunRecordingContext

/**
 * Capture the current recording context by value. Detached async hooks
 * (`stop`, `subagentStop`, …) resolve *after* {@link endHookRunRecording} has
 * cleared the live `current` (decision 3 — the loop never waits for them), so
 * their fire sites snapshot the context synchronously at dispatch and record
 * against the snapshot, keeping decision 6's "always-on" guarantee for async
 * hooks (otherwise the `hook_run` line is dropped or misattributed to a newer
 * run). Returns null when no run is active.
 */
export function snapshotHookRunContext(): HookRunRecordingSnapshot | null {
  return current ? { ...current } : null
}

/**
 * The current run's turn id — the "generation" half of decision 6's attribution,
 * reused as the Cursor hook wire `generation_id` (B4) so a hook's wire payload
 * and its spine `hook_run` line agree on the turn. Null outside an active
 * recording window (the marshaller then emits an empty generation id).
 */
export function getCurrentHookRunTurnId(): string | null {
  return current?.turnId ?? null
}

/** Update the emitting-step attribution (wired to the loop's LLM-call counter). */
export function setHookRunStep(step: number): void {
  if (current) current.step = step
}

/**
 * Fingerprint the toolset offered to the model for this run (decision 6). The
 * content-addressed blob itself is written lazily alongside the first hook_run
 * line that references it, so a run in which no hook fires stores nothing.
 */
export function setHookRunToolset(tools: readonly LLMTool[]): void {
  if (current) current.toolset = fingerprintToolset(tools, sha256)
}

function blobRef(ref: string, contents: string): ContentRef {
  return { ref, sha256: sha256(contents) }
}

/** Blob holding what the hook was handed (command stdin / function payload). */
function payloadBlobRef(id: string): string {
  return `blobs/${id}.payload.json`
}

/** Blob holding the full text of a function hook's applied outcome. */
function outcomeBlobRef(id: string): string {
  return `blobs/${id}.outcome.json`
}

/** Attribution + toolset fields shared by both executor kinds. */
function attributionFields(
  ctx: HookRunRecordingContext,
): Pick<SpineHookRunLine, 'turnId' | 'step' | 'toolset'> {
  return {
    turnId: ctx.turnId,
    step: ctx.step,
    ...(ctx.toolset ? { toolset: ctx.toolset.hash } : {}),
  }
}

function toolsetBlobs(ctx: HookRunRecordingContext): FileToWrite[] {
  if (!ctx.toolset) return []
  return [{ ref: toolsetBlobRef(ctx.toolset.hash), contents: ctx.toolset.contents }]
}

function persist(ctx: HookRunRecordingContext, line: SpineHookRunLine, blobs: FileToWrite[]): void {
  // Emit the live card first so the renderer shows the run promptly; the spine
  // append is the durable record history folds from (both derive one card).
  emitLiveHookCard(line)
  appendHookRun(ctx.projectId, ctx.threadId, line, blobs).catch((err: unknown) => {
    console.warn(`[hook-run-recorder] failed to append hook_run for "${line.hookId}":`, err)
  })
}

/** Normalize a function hook's typed outcome into the compact spine summary. */
function decisionFromOutcome(outcome: BlockingHookOutcome | null): SpineHookRunDecision {
  if (!outcome) return {}
  return {
    ...(outcome.decision !== undefined ? { permission: outcome.decision } : {}),
    ...(outcome.haltRun !== undefined ? { haltRun: true } : {}),
    ...(outcome.updatedInput !== undefined ? { updatedInput: true } : {}),
    ...(outcome.injectContext !== undefined
      ? { injectContextChars: outcome.injectContext.length }
      : {}),
    ...(outcome.agentMessage !== undefined
      ? { agentMessageChars: outcome.agentMessage.length }
      : {}),
    ...(outcome.userMessage !== undefined ? { userMessageChars: outcome.userMessage.length } : {}),
  }
}

/**
 * The full text of every channel a function hook applied — the bodies the
 * compact {@link SpineHookRunDecision} only counts characters of. Written as
 * JSON (stable, machine-readable) rather than prose; the hook-card inspector
 * splits it back into labeled blocks so injected context reads with real
 * newlines instead of escapes.
 */
function outcomeCapture(outcome: BlockingHookOutcome): string | null {
  const captured = {
    ...(outcome.decision !== undefined ? { decision: outcome.decision } : {}),
    ...(outcome.haltRun !== undefined ? { haltReason: outcome.haltRun.reason } : {}),
    ...(outcome.updatedInput !== undefined ? { updatedInput: outcome.updatedInput } : {}),
    ...(outcome.injectContext !== undefined ? { injectContext: outcome.injectContext } : {}),
    ...(outcome.agentMessage !== undefined ? { agentMessage: outcome.agentMessage } : {}),
    ...(outcome.userMessage !== undefined ? { userMessage: outcome.userMessage } : {}),
  }
  return Object.keys(captured).length === 0 ? null : captureJson(captured)
}

/**
 * Payload + outcome blobs for one function-hook execution — the executor's
 * answer to "what did it see, and what did it do?", which command hooks already
 * get for free from their stdin / stdout captures.
 *
 * Captured only for a run that **acted** (returned an outcome) or **threw**. An
 * abstaining hook is the overwhelmingly common case — steering hooks that fire
 * every turn and decline — and its card already reads "No changes", so writing a
 * payload blob per abstain would multiply a thread's blob count for no answer a
 * reader is missing.
 */
function functionCaptureBlobs(
  id: string,
  record: HookRunRecord,
): { refs: Pick<SpineHookRunLine, 'payload' | 'outcome'>; blobs: FileToWrite[] } {
  if (record.outcome === null && record.error === undefined) return { refs: {}, blobs: [] }
  const blobs: FileToWrite[] = []
  const refs: Pick<SpineHookRunLine, 'payload' | 'outcome'> = {}

  const payload = record.payload === undefined ? null : captureJson(record.payload)
  if (payload !== null) {
    const ref = payloadBlobRef(id)
    refs.payload = blobRef(ref, payload)
    blobs.push({ ref, contents: payload })
  }

  const outcome = record.outcome === null ? null : outcomeCapture(record.outcome)
  if (outcome !== null) {
    const ref = outcomeBlobRef(id)
    refs.outcome = blobRef(ref, outcome)
    blobs.push({ ref, contents: outcome })
  }
  return { refs, blobs }
}

/**
 * Sink for first-party function hooks — injected into `HookContext` /
 * `AgentLoopOptions` by the app so `packages/agent` never imports persistence
 * (execution-guidance rule 4). Function hooks run in-process with typed
 * outcomes: no process, so no exit code and no stdout/stderr blobs, and
 * `parseOk` is structurally true. The dispatch payload and the applied outcome
 * are captured as blobs instead, so an in-process hook is as inspectable as a
 * spawned one.
 */
export function recordFunctionHookRun(
  record: HookRunRecord,
  snapshot: HookRunRecordingSnapshot | null = current,
): void {
  const ctx = snapshot
  if (!ctx) return
  const id = randomUUID()
  const captured = functionCaptureBlobs(id, record)
  const line: SpineHookRunLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id,
    event: record.event,
    hookId: record.hookId,
    executor: 'function',
    ...attributionFields(ctx),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    parseOk: true,
    decision: decisionFromOutcome(record.outcome),
    ...(record.error !== undefined ? { error: record.error.slice(0, MAX_ERROR_CHARS) } : {}),
    ...captured.refs,
  }
  persist(ctx, line, [...captured.blobs, ...toolsetBlobs(ctx)])
}

/**
 * Record an async hook dispatch that was **dropped** because the pending-dispatch
 * FIFO was full (decision 13, "cap ~100 then drop-with-spine-record"). The
 * dispatch never ran, so there is no process, exit code, or streams — the line
 * is a zero-duration marker whose `error` names the drop, so an over-cap drop is
 * visible in the transcript rather than silent. `executor` matches the hook kind
 * that would have run.
 */
export function recordDroppedAsyncDispatch(input: {
  event: string
  hookId: string
  executor: 'function' | 'command'
}): void {
  const ctx = current
  if (!ctx) return
  const line: SpineHookRunLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id: randomUUID(),
    event: input.event,
    hookId: input.hookId,
    executor: input.executor,
    ...attributionFields(ctx),
    startedAt: Date.now(),
    durationMs: 0,
    parseOk: true,
    decision: {},
    error: 'async dispatch dropped: pending-dispatch FIFO full (decision 13)',
  }
  persist(ctx, line, toolsetBlobs(ctx))
}

/** Keep the halt reason on the spine bounded — the full text lives in the hook's blob. */
const MAX_STOP_REASON_CHARS = 500

/**
 * Record a `haltRun` **effect** as its own `hook_run` line (H3, decisions 12 &
 * 16). Distinct from the hook's own execution line (which carries `haltRun:
 * true` = "asked to halt"): this marks whether that halt was *applied* (routed
 * through the abort path, aborting the active turn tree) or *suppressed* as a
 * stale no-op (its emitting epoch was no longer current). Zero-duration marker —
 * the abort itself is instantaneous — so an applied or suppressed halt is always
 * visible in the transcript, never silent. No-op outside an active recording
 * window (e.g. a stale halt arriving with no run active).
 */
export function recordHaltRun(
  input: {
    event: string
    hookId: string
    executor: 'function' | 'command'
    /** true = the halt aborted the run; false = suppressed as stale (decision 16). */
    applied: boolean
    reason: string
  },
  /**
   * Recording context snapshotted at the emitting fire site (decision 3/6). A
   * *stale* halt (decision 16) typically arrives after `endHookRunRecording`
   * closed the live window — or while a *newer* turn's window is open — so
   * recording against the live context would drop the suppressed line or
   * attribute it to the wrong turn. Defaults to the live context for blocking
   * halts, which are current by construction.
   */
  snapshot: HookRunRecordingSnapshot | null = current,
): void {
  const ctx = snapshot
  if (!ctx) return
  const decision: SpineHookRunDecision = {
    haltRun: true,
    ...(input.applied ? { haltApplied: true } : { haltSuppressedStale: true }),
    ...(input.reason ? { stopReason: input.reason.slice(0, MAX_STOP_REASON_CHARS) } : {}),
  }
  const line: SpineHookRunLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id: randomUUID(),
    event: input.event,
    hookId: input.hookId,
    executor: input.executor,
    ...attributionFields(ctx),
    startedAt: Date.now(),
    durationMs: 0,
    parseOk: true,
    decision,
  }
  persist(ctx, line, toolsetBlobs(ctx))
}

/** One spawned (command) hook execution, as observed by the command runner. */
export interface CommandHookRunInput {
  /** Dialect event name (e.g. `beforeShellExecution`). */
  event: string
  /** The hook's command string — its stable id in dialect configs. */
  hookId: string
  startedAt: number
  durationMs: number
  /** Process exit code; null when killed (timeout / output cap) or spawn failed. */
  exitCode: number | null
  /** Whether stdout parsed into a response (empty stdout = intentional no-response). */
  parseOk: boolean
  decision: SpineHookRunDecision
  /** The exact JSON written to the hook's stdin, stored verbatim as a blob. */
  stdin: string
  /** Raw captured streams, stored verbatim as blobs. */
  stdout: string
  stderr: string
}

/**
 * Record one command-hook execution. The exact stdin bytes, raw stdout **and**
 * stderr are stored as blobs next to the normalized decision, so a debug print
 * that corrupts a response is visible as `parseOk: false` right next to the
 * bytes — and the payload that provoked it is right there too (decision 6).
 */
export function recordCommandHookRun(
  input: CommandHookRunInput,
  snapshot: HookRunRecordingSnapshot | null = current,
): void {
  const ctx = snapshot
  if (!ctx) return
  const id = randomUUID()
  const stdoutRef = `blobs/${id}.stdout.txt`
  const stderrRef = `blobs/${id}.stderr.txt`
  const payloadRef = payloadBlobRef(id)
  const stdin = boundedCapture(input.stdin)
  const line: SpineHookRunLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id,
    event: input.event,
    hookId: input.hookId,
    executor: 'command',
    ...attributionFields(ctx),
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    parseOk: input.parseOk,
    decision: input.decision,
    stdout: blobRef(stdoutRef, input.stdout),
    stderr: blobRef(stderrRef, input.stderr),
    payload: blobRef(payloadRef, stdin),
  }
  persist(ctx, line, [
    { ref: stdoutRef, contents: input.stdout },
    { ref: stderrRef, contents: input.stderr },
    { ref: payloadRef, contents: stdin },
    ...toolsetBlobs(ctx),
  ])
}
