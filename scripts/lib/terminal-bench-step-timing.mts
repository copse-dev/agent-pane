import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { z } from 'zod'

/**
 * Per-step wall-clock timing for a Terminal-Bench agent run.
 *
 * `copse-trace.jsonl` is buffered and carries no timestamps, so a run killed at
 * the agent timeout loses its last events and cannot say where the time went.
 * This recorder appends one JSON line per event as it happens. A step that was
 * still open when the run was killed shows up as a `step_start` (and maybe a
 * `tool_start`) with no matching end event.
 *
 * Events per step: `step_start` when the model request goes out, `stream_end`
 * when the model stream finishes or is cut, and a `tool_start`/`tool_end` pair
 * around each tool round trip.
 */

export const STEP_TIMING_FILE = 'step-timing.jsonl'

interface TimingBase {
  schemaVersion: 1
  /** Milliseconds since the recorder was created (agent run start). */
  tMs: number
  /** Wall-clock time of the event. */
  at: string
}

export interface StepStartRecord extends TimingBase {
  type: 'step_start'
  step: number
}

export interface StreamEndRecord extends TimingBase {
  type: 'stream_end'
  step: number
  /** Request start to the first chunk that is not prompt-processing progress. */
  prefillMs: number | null
  /** First reasoning/text/tool chunk to the last content chunk. */
  generationMs: number | null
  /** Request start to the end of the stream. */
  modelMs: number
  /** Longest silence between two consecutive content chunks. */
  maxChunkGapMs: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningChars: number
  textChars: number
  toolCalls: string[]
  cutReason: string | null
}

export interface ToolStartRecord extends TimingBase {
  type: 'tool_start'
  step: number
  toolCallId: string
  name: string
}

export interface ToolEndRecord extends TimingBase {
  type: 'tool_end'
  step: number
  toolCallId: string
  name: string
  durationMs: number
  failed: boolean
}

export type StepTimingRecord = StepStartRecord | StreamEndRecord | ToolStartRecord | ToolEndRecord

interface OpenStep {
  step: number
  startedAt: number
  firstContentAt: number | null
  firstNonPromptAt: number | null
  lastContentAt: number | null
  maxChunkGapMs: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningChars: number
  textChars: number
  toolCalls: string[]
  cutReason: string | null
  streamEnded: boolean
}

export interface StepTimingOptions {
  sink: (record: StepTimingRecord) => void
  now?: () => number
}

export class StepTimingRecorder {
  private readonly sink: (record: StepTimingRecord) => void
  private readonly now: () => number
  private readonly origin: number
  private open: OpenStep | undefined
  private readonly toolStarts = new Map<string, { startedAt: number; name: string }>()

  constructor(options: StepTimingOptions) {
    this.sink = options.sink
    this.now = options.now ?? Date.now
    this.origin = this.now()
  }

  /** Call when the agent loop issues the model request for a new step. */
  stepStarted(step: number): void {
    const t = this.now()
    this.endStream(t)
    this.open = {
      step,
      startedAt: t,
      firstContentAt: null,
      firstNonPromptAt: null,
      lastContentAt: null,
      maxChunkGapMs: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningChars: 0,
      textChars: 0,
      toolCalls: [],
      cutReason: null,
      streamEnded: false,
    }
    this.sink({ ...this.stamp(t), type: 'step_start', step })
  }

  chunk(chunk: AgentStreamChunk): void {
    const open = this.open
    if (!open || open.streamEnded) return
    const t = this.now()
    if (chunk.type === 'usage') {
      open.inputTokens = chunk.inputTokens
      open.outputTokens = chunk.outputTokens
      this.endStream(t)
      return
    }
    if (chunk.type === 'done' || chunk.type === 'tool_result') return
    open.firstNonPromptAt ??= chunk.type === 'prompt_progress' ? null : t
    if (chunk.type === 'reasoning' || chunk.type === 'text' || chunk.type === 'tool_call') {
      open.firstContentAt ??= t
      if (open.lastContentAt !== null) {
        open.maxChunkGapMs = Math.max(open.maxChunkGapMs, t - open.lastContentAt)
      }
      open.lastContentAt = t
    }
    if (chunk.type === 'reasoning') open.reasoningChars += chunk.text.length
    if (chunk.type === 'text') open.textChars += chunk.text.length
    if (chunk.type === 'tool_call') open.toolCalls.push(chunk.toolCall.name)
  }

  /** A stream that was cut by the loop never reports usage; close it here. */
  streamCut(cutReason: string): void {
    const open = this.open
    if (!open || open.streamEnded) return
    open.cutReason = cutReason
    this.endStream(this.now())
  }

  toolStarted(toolCallId: string, name: string): void {
    const t = this.now()
    this.toolStarts.set(toolCallId, { startedAt: t, name })
    this.sink({
      ...this.stamp(t),
      type: 'tool_start',
      step: this.open?.step ?? -1,
      toolCallId,
      name,
    })
  }

  toolFinished(toolCallId: string, failed: boolean): void {
    const started = this.toolStarts.get(toolCallId)
    if (!started) return
    this.toolStarts.delete(toolCallId)
    const t = this.now()
    this.sink({
      ...this.stamp(t),
      type: 'tool_end',
      step: this.open?.step ?? -1,
      toolCallId,
      name: started.name,
      durationMs: t - started.startedAt,
      failed,
    })
  }

  /** Call once when the run ends so a stream that never reported usage is closed. */
  finish(): void {
    this.endStream(this.now())
  }

  private endStream(t: number): void {
    const open = this.open
    if (!open || open.streamEnded) return
    open.streamEnded = true
    const streamEnd = open.lastContentAt ?? t
    this.sink({
      ...this.stamp(t),
      type: 'stream_end',
      step: open.step,
      prefillMs: open.firstNonPromptAt === null ? null : open.firstNonPromptAt - open.startedAt,
      generationMs:
        open.firstContentAt === null || open.lastContentAt === null
          ? null
          : open.lastContentAt - open.firstContentAt,
      modelMs: Math.max(streamEnd, t) - open.startedAt,
      maxChunkGapMs: open.maxChunkGapMs,
      inputTokens: open.inputTokens,
      outputTokens: open.outputTokens,
      reasoningChars: open.reasoningChars,
      textChars: open.textChars,
      toolCalls: open.toolCalls,
      cutReason: open.cutReason,
    })
  }

  private stamp(t: number): TimingBase {
    return { schemaVersion: 1, tMs: t - this.origin, at: new Date(t).toISOString() }
  }
}

export function appendStepTimingSink(path: string): (record: StepTimingRecord) => void {
  mkdirSync(dirname(path), { recursive: true })
  return (record) => {
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  }
}

export interface StepTimingSummary {
  steps: number
  /** Sum of request-start to stream-end across steps. */
  modelMs: number
  /** Sum of tool round trips. */
  toolMs: number
  /** Time between the end of a step's last work and the next step's request. */
  overheadMs: number
  /** Time from the last recorded event to the end of the run, when known. */
  trailingMs: number | null
  /** Step whose stream (or tool) was still open when the file stops, if any. */
  openStep: number | null
  maxChunkGapMs: number
}

/**
 * Totals for one run. `runEndMs` is the agent execution duration; passing it
 * attributes the time after the last event (a hung or killed run) to
 * `trailingMs` instead of losing it.
 */
export function summarizeStepTiming(
  records: readonly StepTimingRecord[],
  runEndMs?: number,
): StepTimingSummary {
  let modelMs = 0
  let toolMs = 0
  let overheadMs = 0
  let steps = 0
  let maxChunkGapMs = 0
  let lastEventMs = 0
  let lastWorkEndMs: number | null = null
  const streamEnded = new Set<number>()
  const started = new Set<number>()
  const pendingTools = new Set<string>()
  for (const record of records) {
    lastEventMs = Math.max(lastEventMs, record.tMs)
    switch (record.type) {
      case 'step_start':
        started.add(record.step)
        if (lastWorkEndMs !== null) overheadMs += Math.max(0, record.tMs - lastWorkEndMs)
        lastWorkEndMs = null
        break
      case 'stream_end':
        streamEnded.add(record.step)
        steps += 1
        modelMs += record.modelMs
        maxChunkGapMs = Math.max(maxChunkGapMs, record.maxChunkGapMs)
        lastWorkEndMs = record.tMs
        break
      case 'tool_start':
        pendingTools.add(record.toolCallId)
        break
      case 'tool_end':
        pendingTools.delete(record.toolCallId)
        toolMs += record.durationMs
        lastWorkEndMs = record.tMs
        break
    }
  }
  const openSteps = [...started].filter((step) => !streamEnded.has(step))
  const lastStep = started.size > 0 ? Math.max(...started) : null
  const openStep =
    openSteps.length > 0 ? Math.max(...openSteps) : pendingTools.size > 0 ? lastStep : null
  return {
    steps,
    modelMs,
    toolMs,
    overheadMs,
    trailingMs: runEndMs === undefined ? null : Math.max(0, runEndMs - lastEventMs),
    openStep,
    maxChunkGapMs,
  }
}

const timingBase = { schemaVersion: z.literal(1), tMs: z.number(), at: z.string() }

const stepTimingRecordSchema = z.discriminatedUnion('type', [
  z.object({ ...timingBase, type: z.literal('step_start'), step: z.number() }),
  z.object({
    ...timingBase,
    type: z.literal('stream_end'),
    step: z.number(),
    prefillMs: z.number().nullable(),
    generationMs: z.number().nullable(),
    modelMs: z.number(),
    maxChunkGapMs: z.number(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    reasoningChars: z.number(),
    textChars: z.number(),
    toolCalls: z.array(z.string()),
    cutReason: z.string().nullable(),
  }),
  z.object({
    ...timingBase,
    type: z.literal('tool_start'),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
  }),
  z.object({
    ...timingBase,
    type: z.literal('tool_end'),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
    durationMs: z.number(),
    failed: z.boolean(),
  }),
])

const decodeStepTimingRecord = decodeWithSchema(stepTimingRecordSchema)

/** Parse a `step-timing.jsonl` file, skipping lines that are not valid records. */
export function parseStepTimingLines(text: string): StepTimingRecord[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => safeJsonParse(line, decodeStepTimingRecord))
    .filter((record) => record !== null)
}
