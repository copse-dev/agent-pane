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
import { fingerprintToolset, type ToolsetFingerprint } from '@shared/threads/toolset-fingerprint.ts'
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
 * Sink for first-party function hooks — injected into `HookContext` /
 * `AgentLoopOptions` by the app so `packages/agent` never imports persistence
 * (execution-guidance rule 4). Function hooks run in-process with typed
 * outcomes: no process, so no exit code and no stdout/stderr blobs, and
 * `parseOk` is structurally true.
 */
export function recordFunctionHookRun(record: HookRunRecord): void {
  const ctx = current
  if (!ctx) return
  const line: SpineHookRunLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id: randomUUID(),
    event: record.event,
    hookId: record.hookId,
    executor: 'function',
    ...attributionFields(ctx),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    parseOk: true,
    decision: decisionFromOutcome(record.outcome),
    ...(record.error !== undefined ? { error: record.error.slice(0, MAX_ERROR_CHARS) } : {}),
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
  /** Raw captured streams, stored verbatim as blobs. */
  stdout: string
  stderr: string
}

/**
 * Record one command-hook execution. Raw stdout **and** stderr are stored as
 * blobs next to the normalized decision, so a debug print that corrupts a
 * response is visible as `parseOk: false` right next to the bytes (decision 6).
 */
export function recordCommandHookRun(input: CommandHookRunInput): void {
  const ctx = current
  if (!ctx) return
  const id = randomUUID()
  const stdoutRef = `blobs/${id}.stdout.txt`
  const stderrRef = `blobs/${id}.stderr.txt`
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
  }
  persist(ctx, line, [
    { ref: stdoutRef, contents: input.stdout },
    { ref: stderrRef, contents: input.stderr },
    ...toolsetBlobs(ctx),
  ])
}
