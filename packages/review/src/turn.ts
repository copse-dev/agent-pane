// One model turn over `@copse/agent`'s loop, projected live onto the headless
// contract's event envelope. Stage 2's reviewers, Stage 4's challenger and
// Stage 4's reproducer are all this with a different brief and tool set, so
// they share one runner and one event shape.
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
import type { LLMMessage, LLMProvider, LLMTool } from '@copse/llm/wire-types.ts'
import { errorMessage } from '@copse/std/errors.ts'

export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** True when the provider reported no usage and the figures are a ~4 chars/token estimate. */
  readonly estimated: boolean
}

export interface TurnOptions {
  readonly provider: LLMProvider
  /** Model id, for usage attribution. */
  readonly model: string
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly tools: readonly LLMTool[]
  execute(name: string, args: unknown, signal: AbortSignal, toolCallId: string): Promise<string>
  readonly threadId: string
  readonly turnId: string
  readonly maxSteps: number
  /** A role-specific completion invariant, checked before the terminal event is emitted. */
  readonly completionError?: (() => string | undefined) | undefined
  /**
   * One bounded continuation when the provider ends normally but misses the
   * role-specific completion invariant. The continuation keeps the same
   * transcript and emits no intermediate turn_end, so a successful protocol
   * correction is still one logical turn.
   */
  readonly completionRepair?:
    | {
        readonly tools: readonly LLMTool[]
        readonly maxSteps: number
        prompt(summary: string, completionError: string): string
      }
    | undefined
  readonly signal?: AbortSignal | undefined
  /** Receives each contract event as it happens. */
  readonly onEvent?: ((event: HeadlessEvent) => void) | undefined
}

export interface TurnResult {
  readonly turnId: string
  readonly events: readonly HeadlessEvent[]
  readonly outcome: HeadlessOutcome
  readonly stopReason: HeadlessStopReason
  /** The model's closing plain-text message. */
  readonly summary: string
  readonly usage: TurnUsage
  readonly toolCalls: number
  readonly error?: string
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const messages: LLMMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.userPrompt },
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
    for (const event of projectStreamChunk(pending, { turnId: options.turnId, mintItemId })) {
      emit(event)
    }
    pending = null
  }
  let summary = ''
  let toolCalls = 0
  let usageChunks = 0
  let inputTokens = 0
  let outputTokens = 0
  let doneStopReason: string | undefined
  let error: string | undefined
  let repairDraftSummary: string | undefined

  const runLoop = async (tools: readonly LLMTool[], maxSteps: number): Promise<void> => {
    await runAgentLoop({
      provider: options.provider,
      messages,
      tools: [...tools],
      executeTool: (name, args, signal, toolCallId) =>
        options.execute(name, args, signal, toolCallId),
      ...(options.signal ? { signal: options.signal } : {}),
      maxSteps,
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
        for (const event of projectStreamChunk(chunk, { turnId: options.turnId, mintItemId })) {
          emit(event)
        }
      },
    })
  }

  const readCompletionError = (): string | undefined => {
    if (options.completionError === undefined) return undefined
    try {
      return options.completionError()
    } catch (err) {
      return errorMessage(err)
    }
  }

  emit({
    v: 1,
    type: 'turn_start',
    threadId: options.threadId,
    turnId: options.turnId,
    protocolVersion: HEADLESS_PROTOCOL_VERSION,
  })
  try {
    await runLoop(options.tools, options.maxSteps)
  } catch (err) {
    error = errorMessage(err)
  }
  flushPending()

  if (!(options.signal?.aborted ?? false) && error === undefined && options.completionRepair) {
    const incomplete = readCompletionError()
    if (incomplete !== undefined) {
      repairDraftSummary = summary.trim()
      messages.push({
        role: 'user',
        content: options.completionRepair.prompt(repairDraftSummary, incomplete),
      })
      summary = ''
      doneStopReason = undefined
      try {
        await runLoop(options.completionRepair.tools, options.completionRepair.maxSteps)
      } catch (err) {
        error = errorMessage(err)
      }
      flushPending()
    }
  }
  const cancelled = options.signal?.aborted ?? false
  if (!cancelled && error === undefined) {
    try {
      error = readCompletionError()
    } catch (err) {
      error = errorMessage(err)
    }
  }
  // A failed repair must not overwrite the useful draft analysis that prompted
  // it with a generic second refusal or exhausted-script message.
  if (error !== undefined && repairDraftSummary !== undefined) summary = repairDraftSummary
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
  const usage: TurnUsage = estimated
    ? {
        inputTokens: Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN),
        outputTokens: Math.round(summary.length / CHARS_PER_TOKEN),
        estimated,
      }
    : { inputTokens, outputTokens, estimated }

  return {
    turnId: options.turnId,
    events,
    outcome,
    stopReason,
    summary: summary.trim(),
    usage,
    toolCalls,
    ...(error !== undefined ? { error } : {}),
  }
}

/** Sum usages across turns; estimated if any was. */
export function sumUsage(usages: readonly TurnUsage[]): TurnUsage {
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    estimated: usages.some((usage) => usage.estimated),
  }
}
