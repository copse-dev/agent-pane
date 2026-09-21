// Stage 2 — Fan out (docs/plans/copse-reviewer.md, §Pipeline), Phase 1 shape:
// one model, one lens. The reviewer runs `@copse/agent`'s loop with the
// reviewer tools over the head checkout and the cell, and its run is projected
// onto the headless contract's event envelope as it goes, so a CLI or CI
// caller sees the same `turn_start … turn_end` stream every other headless
// adapter emits. Output is candidate findings, not prose.
import {
  HEADLESS_PROTOCOL_VERSION,
  headlessEventSchema,
  normalizeStopReason,
  projectStreamChunk,
  type HeadlessEvent,
  type HeadlessOutcome,
  type HeadlessStopReason,
} from '@copse/agent/headless-contract.ts'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { hasLastUsage } from '@copse/llm/provider-usage.ts'
import type { LLMMessage, LLMProvider } from '@copse/llm/wire-types.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { renderReviewContext } from './context.ts'
import { lensSystemPrompt, type Lens } from './lenses.ts'
import {
  createReviewerToolExecutor,
  reviewerTools,
  type ReportedCandidate,
  type ReviewerToolHost,
} from './reviewer-tools.ts'
import type { CellCommandResult } from './isolation.ts'

export interface Stage2Options extends ReviewerToolHost {
  readonly provider: LLMProvider
  /** Model id, for provenance and usage attribution. */
  readonly model: string
  readonly lens: Lens
  readonly threadId: string
  readonly turnId: string
  readonly signal?: AbortSignal
  /** Receives each contract event as it happens (a CLI writes them to stdout). */
  readonly onEvent?: (event: HeadlessEvent) => void
  readonly maxSteps?: number
}

export interface Stage2Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** True when the provider reported no usage and the figures are a ~4 chars/token estimate. */
  readonly estimated: boolean
}

export interface Stage2Result {
  readonly model: string
  readonly lens: string
  readonly candidates: readonly ReportedCandidate[]
  readonly commandRuns: ReadonlyMap<string, CellCommandResult>
  readonly events: readonly HeadlessEvent[]
  readonly outcome: HeadlessOutcome
  readonly stopReason: HeadlessStopReason
  /** The reviewer's closing plain-text message: what it checked and what it could not. */
  readonly summary: string
  readonly usage: Stage2Usage
  readonly toolCalls: number
  readonly error?: string
}

export async function runStage2(options: Stage2Options): Promise<Stage2Result> {
  const executor = createReviewerToolExecutor(options)
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: lensSystemPrompt(options.lens, {
        canRun: options.shellDecision === 'allow' && options.cell !== null,
      }),
    },
    { role: 'user', content: renderReviewContext(options.context) },
  ]

  const events: HeadlessEvent[] = []
  let item = 0
  const mintItemId = (): string => `${options.turnId}-item-${String(++item)}`
  const emit = (event: HeadlessEvent): void => {
    headlessEventSchema.parse(event)
    events.push(event)
    options.onEvent?.(event)
  }
  // Text and reasoning stream as deltas; coalesce each run into one item so a
  // message is one event, not one per token, before projecting it.
  let pending: { type: 'text' | 'reasoning'; text: string } | null = null
  const flushPending = (): void => {
    if (pending === null) return
    for (const event of projectStreamChunk(pending, { turnId: options.turnId, mintItemId }))
      emit(event)
    pending = null
  }
  let summary = ''
  let toolCalls = 0
  let usageChunks = 0
  let inputTokens = 0
  let outputTokens = 0
  let doneStopReason: string | undefined
  let error: string | undefined

  emit({
    v: 1,
    type: 'turn_start',
    threadId: options.threadId,
    turnId: options.turnId,
    protocolVersion: HEADLESS_PROTOCOL_VERSION,
  })
  try {
    await runAgentLoop({
      provider: options.provider,
      messages,
      tools: reviewerTools(),
      executeTool: (name, args, signal, toolCallId) =>
        executor.execute(name, args, signal, toolCallId),
      ...(options.signal ? { signal: options.signal } : {}),
      maxSteps: options.maxSteps ?? options.lens.maxSteps,
      adaptiveExtensions: false,
      usageModel: options.model,
      getLastUsage: () => (hasLastUsage(options.provider) ? options.provider.lastUsage : null),
      onChunk: (chunk: AgentStreamChunk) => {
        if (chunk.type === 'text' || chunk.type === 'reasoning') {
          if (pending !== null && pending.type !== chunk.type) flushPending()
          pending = { type: chunk.type, text: (pending?.text ?? '') + chunk.text }
          if (chunk.type === 'text') summary += chunk.text
          return
        }
        flushPending()
        if (chunk.type === 'tool_call') {
          toolCalls += 1
          // A fresh answer follows a tool round; the closing summary is the last text.
          summary = ''
        }
        if (chunk.type === 'usage') {
          usageChunks += 1
          inputTokens += chunk.inputTokens
          outputTokens += chunk.outputTokens
        }
        if (chunk.type === 'done') doneStopReason = chunk.stopReason
        for (const event of projectStreamChunk(chunk, { turnId: options.turnId, mintItemId }))
          emit(event)
      },
    })
  } catch (err) {
    error = errorMessage(err)
  }
  flushPending()

  const cancelled = options.signal?.aborted ?? false
  const outcome: HeadlessOutcome = cancelled
    ? 'cancelled'
    : error !== undefined
      ? 'failed'
      : 'completed'
  const stopReason: HeadlessStopReason = cancelled
    ? 'cancelled'
    : error !== undefined
      ? 'error'
      : normalizeStopReason(doneStopReason)
  emit({ v: 1, type: 'turn_end', turnId: options.turnId, outcome, stopReason })

  const estimated = usageChunks === 0
  const usage: Stage2Usage = estimated
    ? {
        inputTokens: Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN),
        outputTokens: Math.round(summary.length / CHARS_PER_TOKEN),
        estimated,
      }
    : { inputTokens, outputTokens, estimated }

  return {
    model: options.model,
    lens: options.lens.id,
    candidates: executor.reported(),
    commandRuns: executor.commandRuns(),
    events,
    outcome,
    stopReason,
    summary: summary.trim(),
    usage,
    toolCalls,
    ...(error !== undefined ? { error } : {}),
  }
}
