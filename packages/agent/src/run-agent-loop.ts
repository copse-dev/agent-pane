import { errorMessage } from './internal-utils.ts'
import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  ToolCallChunk,
  ToolResult,
} from '@copse/llm/wire-types.ts'
import type { AgentStreamChunk, ToolExecuteResult } from './wire-types.ts'
import { normalizeToolExecuteResult } from './wire-types.ts'
import {
  trimMessagesInPlace,
  repairToolUseToolResultPairing,
  CANCELLED_TOOL_RESULT,
  getLastMeasuredInputTokens,
  setLastMeasuredInputTokens,
} from './trim-history.ts'
import type { TodoItem } from './wire-types.ts'
import {
  DUPLICATE_TOOL_RESULT_PREFIX,
  isDuplicateExploreCall,
  LOOP_NUDGE_USER_MESSAGE,
  normalizeExploreArgs,
  STUCK_FINALIZE_NUDGE,
  toolCallFingerprint,
} from './agent-loop-guards.ts'
import {
  measureConversationPressure,
  shouldForceTextAnswer,
  shouldInjectLoopNudge,
} from './agent-loop-escalation.ts'
import { recoverTextToolCalls, type CoerceToolArgsFn } from './parse-text-tool-calls.ts'
import {
  CONTEXT_OVERFLOW_USER_MESSAGE,
  isContextOverflowStopReason,
  isRefusalStopReason,
  isTruncationStopReason,
  REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  REASONING_RUNAWAY_GIVEUP_MESSAGE,
  REFUSAL_USER_MESSAGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '@copse/llm/provider-stop-reason.ts'
import {
  AGENT_RUN_HARD_MAX_MS,
  AGENT_RUN_IDLE_TIMEOUT_MS,
  AgentRunDeadline,
  defaultMaxLlmCallsForSteps,
  isAgentRunTimeoutAbort,
  isStreamOutputRunaway,
} from './agent-loop-limits.ts'
import { hasOpenTodos, OPEN_TODOS_STILL_OPEN_MESSAGE } from './agent-loop-guards.ts'
import { createHookRegistry, mergeBlockingOutcomes } from './hooks/hook-registry.ts'
import type { HookContext } from './hooks/canonical-events.ts'

const RECENT_FINGERPRINT_WINDOW = 16
/** Consecutive reasoning-only runaway streams tolerated before the run gives up. */
const MAX_REASONING_RUNAWAY_STREAK = 2
/** Do not compact on the first tool round unless the transcript is critically full. */
const TRIM_CRITICAL_FILL = 0.95
/** After this many tool rounds, always allow normal in-loop compaction. */
const TRIM_DEFER_MAX_TOOL_STEPS = 2

export interface AgentLoopOptions {
  provider: LLMProvider
  messages: LLMMessage[] // mutated in-place as turns are added
  tools: LLMTool[]
  onChunk: (chunk: AgentStreamChunk) => void
  executeTool: (
    name: string,
    args: unknown,
    signal: AbortSignal,
    toolCallId: string,
  ) => Promise<ToolExecuteResult>
  signal?: AbortSignal
  maxSteps?: number
  /** Trim in-loop history to this context size (tokens). */
  maxContextTokens?: number
  /** Reserve headroom for tool JSON schemas on each provider call. */
  toolSchemaReserveTokens?: number
  onHistoryTrimmed?: () => void
  /** Called after each provider stream to read per-step token usage. */
  getLastUsage?: () => { inputTokens: number; outputTokens: number } | null
  /** Model id for usage/cost attribution on this loop's provider calls. */
  usageModel?: string
  /** Max provider.stream calls (main loop + finalize / forced text). */
  maxLlmCalls?: number
  /** Shared sliding-idle deadline. When omitted, one is created from runTimeoutMs. */
  runDeadline?: AgentRunDeadline
  /** Idle timeout when runDeadline is omitted. */
  runTimeoutMs?: number
  /** Hard wall-clock cap when runDeadline is omitted. */
  runHardMaxMs?: number
  /** Called when the deadline records activity (reschedule external abort timers). */
  onRunDeadlineActivity?: () => void
  /** Coerce recovered XML tool args against registered tool schemas. */
  coerceTextToolCallArgs?: CoerceToolArgsFn
  /** When set, finalize is blocked while todos remain open. */
  getOpenTodos?: () => readonly TodoItem[]
  /**
   * Spine-recording sink for hook executions fired inside the loop (decision 6).
   * Injected by the host — the loop and registry never import persistence.
   */
  recordHookRun?: HookContext['recordHookRun']
  /**
   * Called after each reserved LLM call with the running call count. The host
   * uses it to attribute hook executions to their emitting step (decision 6);
   * purely observational, never awaited.
   */
  onLlmCall?: (count: number) => void
}

const FINALIZE_NUDGE =
  'Based on your exploration so far, write a clear final answer for the user. Do not call any tools.'

const INCOMPLETE_RUN_MESSAGE =
  'The agent stopped before producing a final answer. Try a shorter question, reduce tool use, or switch models.'

const RUN_LIMIT_MESSAGE =
  'The agent run reached its time or LLM call limit before finishing. Try a shorter question or start a new turn.'

type LlmCallBudget = {
  llmCalls: number
  maxLlmCalls: number
  deadline: AgentRunDeadline
  signal?: AbortSignal
  onRunDeadlineActivity?: () => void
  onLlmCall?: (count: number) => void
}

function recordRunActivity(budget: LlmCallBudget): void {
  budget.deadline.recordActivity()
  budget.onRunDeadlineActivity?.()
}

function runBudgetExhausted(budget: LlmCallBudget): boolean {
  if (budget.deadline.isExpired()) return true
  if (budget.llmCalls >= budget.maxLlmCalls) return true
  return false
}

function reserveLlmCall(budget: LlmCallBudget): boolean {
  if (runBudgetExhausted(budget)) return false
  budget.llmCalls++
  budget.onLlmCall?.(budget.llmCalls)
  return true
}

type StepUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * Resolve a single step's usage, preferring usage captured from the stream
 * itself (`streamUsage`) over the shared mutable `provider.lastUsage`. Reading
 * per-stream usage avoids cross-stream races and mis-attribution when a
 * subagent reuses the parent provider (#112).
 */
function emitStepUsage(
  streamUsage: StepUsage | null,
  getLastUsage: (() => StepUsage | null) | undefined,
  onChunk: (chunk: AgentStreamChunk) => void,
  usageModel?: string,
): void {
  const usage = streamUsage ?? getLastUsage?.()
  if (usage?.inputTokens) {
    setLastMeasuredInputTokens(usage.inputTokens)
  }
  if (usage && (usage.inputTokens || usage.outputTokens) && usageModel) {
    onChunk({
      type: 'usage',
      model: usageModel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
    })
  }
}

function emitContextPressure(
  input: {
    messages: LLMMessage[]
    maxContextTokens: number
    toolSchemaReserveTokens: number
    toolOnlySteps: number
    trimEvents: number
  },
  onChunk: (chunk: AgentStreamChunk) => void,
): void {
  const pressure = measureConversationPressure(input)
  onChunk({
    type: 'context_pressure',
    contextWindow: input.maxContextTokens,
    conversationBudget: pressure.conversationBudget,
    conversationTokens: pressure.conversationTokens,
    fillRatio: pressure.fillRatio,
  })
}

/** When native tool_calls are absent, parse Cursor-style XML embedded in assistant text. */
function applyTextToolCallRecovery(
  assistantText: string,
  pendingToolCalls: ToolCallChunk[],
  onChunk: (chunk: AgentStreamChunk) => void,
  coerceTextToolCallArgs?: CoerceToolArgsFn,
): string {
  // Recover on either the Cursor `<tool_call>` wrapper or a bare Anthropic/MiniMax
  // `<invoke name="…">` block — MiniMax emits the latter with no wrapper (#519), and
  // gating on `<tool_call>` alone left those turns to leak raw XML as a final answer.
  const hasEmbeddedCall =
    /<\s*tool_call\s*>/i.test(assistantText) || /<\s*invoke\b/i.test(assistantText)
  if (pendingToolCalls.length > 0 || !hasEmbeddedCall) {
    return assistantText
  }
  const recovered = recoverTextToolCalls(assistantText, coerceTextToolCallArgs)
  if (recovered.toolCalls.length > 0) {
    assistantText = recovered.cleanedText
    onChunk({ type: 'text_replace', text: assistantText })
    for (const tc of recovered.toolCalls) {
      pendingToolCalls.push(tc)
      onChunk({ type: 'tool_call', toolCall: tc })
    }
  } else if (!recovered.keptRawBlocks) {
    assistantText = recovered.cleanedText
    onChunk({ type: 'text_replace', text: assistantText })
  }
  return assistantText
}

interface TextOnlyTurnResult {
  /** Set when the turn finishes as plain text (no recovered tools). */
  answerText: string
  /** Recovered tool calls the caller should execute before treating the run as finished. */
  pendingToolCalls: ToolCallChunk[]
}

async function streamTextOnlyTurn(
  provider: LLMProvider,
  messages: LLMMessage[],
  onChunk: (chunk: AgentStreamChunk) => void,
  budget: LlmCallBudget,
  nudge = FINALIZE_NUDGE,
  getLastUsage?: () => { inputTokens: number; outputTokens: number } | null,
  usageModel?: string,
  coerceTextToolCallArgs?: CoerceToolArgsFn,
): Promise<TextOnlyTurnResult> {
  const empty: TextOnlyTurnResult = { answerText: '', pendingToolCalls: [] }
  if (!reserveLlmCall(budget)) return empty
  const signal = budget.signal
  const turnMessages: LLMMessage[] = [...messages, { role: 'user', content: nudge }]
  let assistantText = ''
  let stopReason: string | undefined
  let streamUsage: StepUsage | null = null
  let streamOutputChars = 0

  budget.deadline.pause()
  try {
    for await (const chunk of provider.stream(turnMessages, [], signal)) {
      if (signal?.aborted) break
      if (chunk.type === 'reasoning') {
        streamOutputChars += chunk.text.length
        onChunk(chunk)
      }
      if (chunk.type === 'text') {
        streamOutputChars += chunk.text.length
        assistantText += chunk.text
        onChunk(chunk)
      }
      if (chunk.type === 'usage') {
        streamUsage = {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          ...(chunk.cacheReadTokens !== undefined
            ? { cacheReadTokens: chunk.cacheReadTokens }
            : {}),
          ...(chunk.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: chunk.cacheCreationTokens }
            : {}),
        }
      }
      if (chunk.type === 'done') {
        stopReason = chunk.stopReason
        break
      }
      // Backstop a runaway finalize/forced-text generation the same way the main
      // loop does, so a local model can't stream indefinitely here either (#489).
      if (isStreamOutputRunaway(streamOutputChars)) {
        stopReason = 'max_tokens'
        break
      }
    }
  } finally {
    budget.deadline.resume()
  }
  recordRunActivity(budget)

  const pendingToolCalls: ToolCallChunk[] = []
  assistantText = applyTextToolCallRecovery(
    assistantText,
    pendingToolCalls,
    onChunk,
    coerceTextToolCallArgs,
  )

  if (pendingToolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
    })
    emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)
    return { answerText: '', pendingToolCalls }
  }

  const trimmed = assistantText.trim()
  if (isRefusalStopReason(stopReason)) {
    const text = trimmed || REFUSAL_USER_MESSAGE
    if (!trimmed) onChunk({ type: 'text', text })
    messages.push({ role: 'assistant', content: text })
    emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)
    return { answerText: text, pendingToolCalls: [] }
  }
  if (trimmed) {
    messages.push({ role: 'assistant', content: assistantText })
  } else if (isTruncationStopReason(stopReason)) {
    messages.push({ role: 'user', content: TRUNCATION_CONTINUE_NUDGE })
  }
  emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)
  return { answerText: trimmed, pendingToolCalls: [] }
}

type AgentStepContext = {
  provider: LLMProvider
  messages: LLMMessage[]
  tools: LLMTool[]
  onChunk: (chunk: AgentStreamChunk) => void
  executeTool: AgentLoopOptions['executeTool']
  signal?: AbortSignal | undefined
  budget: LlmCallBudget
  recentFingerprints: string[]
  getLastUsage?: () => { inputTokens: number; outputTokens: number } | null
  usageModel?: string
  coerceTextToolCallArgs?: CoerceToolArgsFn
  maxContextTokens?: number
  toolSchemaReserveTokens: number
  onHistoryTrimmed?: () => void
  recordHookRun?: HookContext['recordHookRun']
}

/** One tool-enabled turn after injecting a user nudge (used for todo closeout). */
async function runToolEnabledNudgeTurn(
  ctx: AgentStepContext,
  nudge: string,
): Promise<{ answerText: string; executedTools: boolean }> {
  const {
    provider,
    messages,
    tools,
    onChunk,
    executeTool,
    signal,
    budget,
    recentFingerprints,
    getLastUsage,
    usageModel,
    coerceTextToolCallArgs,
    maxContextTokens,
    toolSchemaReserveTokens,
    onHistoryTrimmed,
  } = ctx

  messages.push({ role: 'user', content: nudge })
  if (!reserveLlmCall(budget)) return { answerText: '', executedTools: false }

  let assistantText = ''
  const pendingToolCalls: ToolCallChunk[] = []
  let streamUsage: StepUsage | null = null

  budget.deadline.pause()
  try {
    for await (const chunk of provider.stream(messages, tools, signal)) {
      if (signal?.aborted) break
      if (chunk.type === 'reasoning') onChunk(chunk)
      if (chunk.type === 'text') {
        assistantText += chunk.text
        onChunk(chunk)
      }
      if (chunk.type === 'tool_call') {
        pendingToolCalls.push(chunk.toolCall)
        onChunk(chunk)
      }
      if (chunk.type === 'usage') {
        streamUsage = {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          ...(chunk.cacheReadTokens !== undefined
            ? { cacheReadTokens: chunk.cacheReadTokens }
            : {}),
          ...(chunk.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: chunk.cacheCreationTokens }
            : {}),
        }
      }
      if (chunk.type === 'done') break
    }
  } finally {
    budget.deadline.resume()
  }
  recordRunActivity(budget)
  emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)

  assistantText = applyTextToolCallRecovery(
    assistantText,
    pendingToolCalls,
    onChunk,
    coerceTextToolCallArgs,
  )

  if (pendingToolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
    })
    await executeToolBatch({
      pendingToolCalls,
      messages,
      executeTool,
      signal,
      onChunk,
      recentFingerprints,
      budget,
    })
    if (maxContextTokens) {
      const reserve = tools.length > 0 ? toolSchemaReserveTokens : 0
      if (trimMessagesInPlace(messages, maxContextTokens, { reserveTokens: reserve })) {
        onHistoryTrimmed?.()
      }
    }
    return { answerText: assistantText.trim(), executedTools: true }
  }

  if (assistantText.trim()) {
    messages.push({ role: 'assistant', content: assistantText })
  }
  return { answerText: assistantText.trim(), executedTools: false }
}

/**
 * Run tool-enabled closeout turns while open todos remain. Nudge selection and
 * the attempt budget live in `beforeFinalize` hooks (M0.3); this site only
 * fires the event and runs the returned `injectContext` as a nudge. Returns
 * true once no todos are open.
 */
async function closeOpenTodosBeforeFinalize(
  ctx: AgentStepContext,
  getOpenTodos: () => readonly TodoItem[],
): Promise<boolean> {
  const registry = createHookRegistry()
  const hookContext: HookContext = {
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.recordHookRun !== undefined ? { recordHookRun: ctx.recordHookRun } : {}),
  }
  for (let attempt = 0; ; attempt++) {
    const openTodos = getOpenTodos()
    if (!hasOpenTodos(openTodos)) return true
    const result = await registry.emit('beforeFinalize', { openTodos, attempt }, hookContext)
    const nudge = mergeBlockingOutcomes(result.outcomes).injectContext
    if (!nudge) break
    await runToolEnabledNudgeTurn(ctx, nudge)
    if (ctx.signal?.aborted) break
  }
  return !hasOpenTodos(getOpenTodos())
}

type ToolBatchContext = {
  pendingToolCalls: ToolCallChunk[]
  messages: LLMMessage[]
  executeTool: AgentLoopOptions['executeTool']
  signal?: AbortSignal | undefined
  onChunk: (chunk: AgentStreamChunk) => void
  recentFingerprints: string[]
  budget: LlmCallBudget
}

/**
 * How many `explore` subagents may run concurrently when the model fans out
 * several in one turn. Bounded so a wide fan-out doesn't stack up nested
 * model streams and search subprocesses.
 */
const EXPLORE_PARALLELISM = 4

type SettledToolExecution =
  | { ok: true; value: string | ToolExecuteResult }
  | { ok: false; error: unknown }

/**
 * Pre-start the batch's leading run of consecutive `explore` calls so those
 * subagents run concurrently instead of one-after-another — each is a nested
 * agent loop of up to ~10 model round-trips, so a serial ×3 fan-out triples
 * the wall-clock for no reason (explores are read-only). Only the *leading*
 * run is parallelized: an explore that follows another tool in the same batch
 * must still observe that tool's effects, so it stays serial. Duplicate
 * explores (per the fingerprint guard) are left to the serial loop, which
 * answers them without executing. Each promise is settled into a result shape
 * immediately so an early rejection can't raise an unhandled rejection while
 * the loop is still on an earlier call.
 *
 * Note: concurrent subagents share the `lastMeasuredInputTokens` global, so a
 * subagent's trim heuristic may read a sibling's measurement. Explore
 * histories are small (≤10 steps) and the parent's snapshot/restore around
 * the batch is unaffected, so the worst case is a slightly early/late trim
 * inside one subagent.
 */
function startLeadingParallelExplores(
  ctx: ToolBatchContext,
): Map<string, Promise<SettledToolExecution>> {
  const { pendingToolCalls, executeTool, signal, recentFingerprints } = ctx
  const started = new Map<string, Promise<SettledToolExecution>>()

  // Mirror the serial loop's duplicate detection (same order, same window) so
  // a call the loop will refuse is never pre-executed.
  const fingerprints = [...recentFingerprints]
  const leading: { tc: ToolCallChunk; args: unknown }[] = []
  for (const tc of pendingToolCalls) {
    if (tc.name !== 'explore' || tc.argsError) break
    const args = normalizeExploreArgs(tc.name, tc.args)
    if (!isDuplicateExploreCall(tc.name, args, fingerprints)) leading.push({ tc, args })
    fingerprints.push(toolCallFingerprint(tc.name, args))
  }
  if (leading.length < 2) return started

  let active = 0
  const waiters: (() => void)[] = []
  const acquire = async (): Promise<void> => {
    if (active < EXPLORE_PARALLELISM) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
    active += 1
  }
  const release = (): void => {
    active -= 1
    waiters.shift()?.()
  }

  for (const { tc, args } of leading) {
    started.set(
      tc.id,
      (async (): Promise<SettledToolExecution> => {
        await acquire()
        try {
          const value = await executeTool(
            tc.name,
            args,
            signal ?? new AbortController().signal,
            tc.id,
          )
          return { ok: true, value }
        } catch (error) {
          return { ok: false, error }
        } finally {
          release()
        }
      })(),
    )
  }
  return started
}

async function executeToolBatch(ctx: ToolBatchContext): Promise<void> {
  const { pendingToolCalls, messages, executeTool, signal, onChunk, recentFingerprints, budget } =
    ctx
  const measuredInputBeforeTools = getLastMeasuredInputTokens()
  const toolResults: ToolResult[] = []
  budget.deadline.pause()
  try {
    const startedExplores = startLeadingParallelExplores(ctx)
    for (let ti = 0; ti < pendingToolCalls.length; ti++) {
      const tc = pendingToolCalls[ti]
      if (!tc) continue
      if (signal?.aborted) {
        for (let j = ti; j < pendingToolCalls.length; j++) {
          const cancelled = pendingToolCalls[j]
          if (!cancelled) continue
          toolResults.push({ toolCallId: cancelled.id, result: CANCELLED_TOOL_RESULT })
          onChunk({
            type: 'tool_result',
            toolCallId: cancelled.id,
            result: CANCELLED_TOOL_RESULT,
            isError: true,
          })
        }
        break
      }
      if (tc.argsError) {
        const result = `Error: ${tc.argsError}`
        toolResults.push({ toolCallId: tc.id, result })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result, isError: true })
        continue
      }
      const normalizedArgs = normalizeExploreArgs(tc.name, tc.args)
      const fp = toolCallFingerprint(tc.name, normalizedArgs)
      const duplicate = isDuplicateExploreCall(tc.name, normalizedArgs, recentFingerprints)
      recentFingerprints.push(fp)
      if (recentFingerprints.length > RECENT_FINGERPRINT_WINDOW) {
        recentFingerprints.shift()
      }

      try {
        let raw: string | ToolExecuteResult
        if (duplicate) {
          raw = DUPLICATE_TOOL_RESULT_PREFIX
        } else {
          const preStarted = startedExplores.get(tc.id)
          if (preStarted) {
            const settled = await preStarted
            if (!settled.ok) throw settled.error
            raw = settled.value
          } else {
            raw = await executeTool(
              tc.name,
              normalizedArgs,
              signal ?? new AbortController().signal,
              tc.id,
            )
          }
        }
        const { result, editStats } = normalizeToolExecuteResult(raw)
        toolResults.push({ toolCallId: tc.id, result })
        onChunk({
          type: 'tool_result',
          toolCallId: tc.id,
          result,
          isError: false,
          ...(editStats ? { editStats } : {}),
        })
      } catch (err) {
        const msg = errorMessage(err)
        toolResults.push({ toolCallId: tc.id, result: `Error: ${msg}` })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result: `Error: ${msg}`, isError: true })
      }
    }
  } finally {
    budget.deadline.resume()
  }

  setLastMeasuredInputTokens(measuredInputBeforeTools)

  if (toolResults.length > 0) {
    messages.push({ role: 'tool', toolResults })
  }
  recordRunActivity(budget)
}

function handleContextOverflowInLoop(
  messages: LLMMessage[],
  maxContextTokens: number | undefined,
  toolSchemaReserveTokens: number,
  tools: LLMTool[],
  onChunk: (chunk: AgentStreamChunk) => void,
  onHistoryTrimmed?: () => void,
): boolean {
  if (!maxContextTokens) {
    onChunk({ type: 'text', text: CONTEXT_OVERFLOW_USER_MESSAGE })
    messages.push({ role: 'assistant', content: CONTEXT_OVERFLOW_USER_MESSAGE })
    return true
  }
  const reserve = tools.length > 0 ? toolSchemaReserveTokens : 0
  if (trimMessagesInPlace(messages, maxContextTokens, { reserveTokens: reserve })) {
    onHistoryTrimmed?.()
    return false
  }
  onChunk({ type: 'text', text: CONTEXT_OVERFLOW_USER_MESSAGE })
  messages.push({ role: 'assistant', content: CONTEXT_OVERFLOW_USER_MESSAGE })
  return true
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  setLastMeasuredInputTokens(null)
  const {
    provider,
    messages,
    tools,
    onChunk,
    signal,
    maxSteps = 20,
    maxContextTokens,
    toolSchemaReserveTokens = 0,
    onHistoryTrimmed,
    getLastUsage,
    usageModel,
    maxLlmCalls = defaultMaxLlmCallsForSteps(maxSteps),
    runDeadline,
    runTimeoutMs = AGENT_RUN_IDLE_TIMEOUT_MS,
    runHardMaxMs = AGENT_RUN_HARD_MAX_MS,
    onRunDeadlineActivity,
    coerceTextToolCallArgs,
    getOpenTodos,
    recordHookRun,
    onLlmCall,
  } = opts
  const deadline = runDeadline ?? new AgentRunDeadline(runTimeoutMs, runHardMaxMs)
  const budget: LlmCallBudget = {
    llmCalls: 0,
    maxLlmCalls,
    deadline,
    ...(signal !== undefined ? { signal } : {}),
    ...(onRunDeadlineActivity !== undefined ? { onRunDeadlineActivity } : {}),
    ...(onLlmCall !== undefined ? { onLlmCall } : {}),
  }
  let steps = 0
  let finishedWithAnswer = false
  let hitRunLimit = false
  let toolOnlySteps = 0
  let loopNudgeSent = false
  let forceTextAttempted = false
  let trimEvents = 0
  // Consecutive streams cut off by the per-stream output cap while producing only
  // reasoning (no answer, no tool call). The first gets a force-answer nudge; a
  // second means the model is stuck looping, so the run ends instead of re-priming.
  let reasoningRunawayStreak = 0
  const recentFingerprints: string[] = []

  while (steps < maxSteps) {
    if (runBudgetExhausted(budget)) {
      hitRunLimit = true
      break
    }
    if (signal?.aborted) break
    steps++

    repairToolUseToolResultPairing(messages)

    if (maxContextTokens) {
      const escalationInput = {
        messages,
        maxContextTokens,
        toolSchemaReserveTokens,
        toolOnlySteps,
        trimEvents,
      }
      const pressure = measureConversationPressure(escalationInput)

      if (!forceTextAttempted && shouldForceTextAnswer(escalationInput, pressure)) {
        forceTextAttempted = true
        const forced = await streamTextOnlyTurn(
          provider,
          messages,
          onChunk,
          budget,
          STUCK_FINALIZE_NUDGE,
          getLastUsage,
          usageModel,
          coerceTextToolCallArgs,
        )
        if (forced.pendingToolCalls.length > 0) {
          await executeToolBatch({
            pendingToolCalls: forced.pendingToolCalls,
            messages,
            executeTool: opts.executeTool,
            signal,
            onChunk,
            recentFingerprints,
            budget,
          })
          toolOnlySteps++
          continue
        }
        if (forced.answerText.trim()) {
          finishedWithAnswer = true
          break
        }
      }

      if (!loopNudgeSent && shouldInjectLoopNudge(escalationInput, pressure)) {
        messages.push({ role: 'user', content: LOOP_NUDGE_USER_MESSAGE })
        loopNudgeSent = true
      }

      const reserve = tools.length > 0 ? toolSchemaReserveTokens : 0
      const skipSoftTrim =
        toolOnlySteps <= TRIM_DEFER_MAX_TOOL_STEPS && pressure.fillRatio < TRIM_CRITICAL_FILL
      if (
        !skipSoftTrim &&
        trimMessagesInPlace(messages, maxContextTokens, { reserveTokens: reserve })
      ) {
        trimEvents++
        onHistoryTrimmed?.()
      }
    }

    // Collect one full LLM response
    let assistantText = ''
    const pendingToolCalls: ToolCallChunk[] = []
    let stopReason: string | undefined
    let streamUsage: StepUsage | null = null

    if (!reserveLlmCall(budget)) {
      hitRunLimit = true
      break
    }

    let streamOutputChars = 0
    let streamCappedAsRunaway = false

    budget.deadline.pause()
    try {
      for await (const chunk of provider.stream(messages, tools, signal)) {
        if (signal?.aborted) break
        if (chunk.type === 'reasoning') {
          streamOutputChars += chunk.text.length
          onChunk(chunk)
        }
        if (chunk.type === 'text') {
          streamOutputChars += chunk.text.length
          assistantText += chunk.text
          onChunk(chunk)
        }
        if (chunk.type === 'tool_call') {
          pendingToolCalls.push(chunk.toolCall)
          onChunk(chunk)
        }
        if (chunk.type === 'usage') {
          streamUsage = {
            inputTokens: chunk.inputTokens,
            outputTokens: chunk.outputTokens,
            ...(chunk.cacheReadTokens !== undefined
              ? { cacheReadTokens: chunk.cacheReadTokens }
              : {}),
            ...(chunk.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: chunk.cacheCreationTokens }
              : {}),
          }
        }
        if (chunk.type === 'done') {
          stopReason = chunk.stopReason
          break
        }
        // Backstop against a single runaway generation (common with local
        // OpenAI-compatible servers that ignore output caps): stop consuming and
        // treat the partial turn as truncated so the loop can recover (#489).
        if (!pendingToolCalls.length && isStreamOutputRunaway(streamOutputChars)) {
          stopReason = 'max_tokens'
          streamCappedAsRunaway = true
          break
        }
      }
    } finally {
      budget.deadline.resume()
    }
    recordRunActivity(budget)

    emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)

    if (maxContextTokens) {
      emitContextPressure(
        {
          messages,
          maxContextTokens,
          toolSchemaReserveTokens,
          toolOnlySteps,
          trimEvents,
        },
        onChunk,
      )
    }

    if (signal?.aborted) break

    assistantText = applyTextToolCallRecovery(
      assistantText,
      pendingToolCalls,
      onChunk,
      coerceTextToolCallArgs,
    )

    // Push assistant message to history
    if (pendingToolCalls.length > 0) {
      reasoningRunawayStreak = 0
      messages.push({
        role: 'assistant',
        content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      })
      if (isTruncationStopReason(stopReason)) {
        messages.push({ role: 'user', content: TRUNCATION_CONTINUE_NUDGE })
      }
    } else if (isRefusalStopReason(stopReason)) {
      const text = assistantText.trim() || REFUSAL_USER_MESSAGE
      if (!assistantText.trim()) onChunk({ type: 'text', text })
      messages.push({ role: 'assistant', content: text })
      finishedWithAnswer = true
      break
    } else if (isContextOverflowStopReason(stopReason)) {
      if (
        handleContextOverflowInLoop(
          messages,
          maxContextTokens,
          toolSchemaReserveTokens,
          tools,
          onChunk,
          onHistoryTrimmed,
        )
      ) {
        finishedWithAnswer = true
        break
      }
      continue
    } else if (assistantText.trim()) {
      reasoningRunawayStreak = 0
      if (isTruncationStopReason(stopReason)) {
        messages.push({ role: 'assistant', content: assistantText })
        messages.push({ role: 'user', content: TRUNCATION_CONTINUE_NUDGE })
        continue
      }
      messages.push({ role: 'assistant', content: assistantText })
      finishedWithAnswer = true
      break
    } else {
      if (isTruncationStopReason(stopReason)) {
        // A pure-reasoning stream that our own output cap cut off (#489) has no
        // assistant text or tool call, and reasoning never lands in history — so
        // TRUNCATION_CONTINUE_NUDGE ("continue from where you left off") has nothing
        // to continue and just re-primes the same loop. Push the model to commit to
        // an answer instead; if it ignores that and runs the cap again, it is stuck
        // looping, so end the run rather than re-prime until the wall-clock deadline.
        if (streamCappedAsRunaway) {
          reasoningRunawayStreak++
          if (reasoningRunawayStreak >= MAX_REASONING_RUNAWAY_STREAK) {
            onChunk({ type: 'text', text: REASONING_RUNAWAY_GIVEUP_MESSAGE })
            messages.push({ role: 'assistant', content: REASONING_RUNAWAY_GIVEUP_MESSAGE })
            finishedWithAnswer = true
            break
          }
          messages.push({ role: 'user', content: REASONING_RUNAWAY_FORCE_ANSWER_NUDGE })
          continue
        }
        messages.push({ role: 'user', content: TRUNCATION_CONTINUE_NUDGE })
        continue
      }
      if (isContextOverflowStopReason(stopReason)) {
        if (
          handleContextOverflowInLoop(
            messages,
            maxContextTokens,
            toolSchemaReserveTokens,
            tools,
            onChunk,
            onHistoryTrimmed,
          )
        ) {
          finishedWithAnswer = true
          break
        }
        continue
      }
      // Empty turn (common when context is tight) — keep looping instead of exiting early.
      continue
    }

    // Execute tools and collect results. A tool may run a nested agent loop
    // (explore subagent, local todo worker), and `setLastMeasuredInputTokens`
    // is a module global that the nested loop resets and repopulates with its
    // own stream sizes. Snapshot this loop's measured input here and restore it
    // after the tools finish so the next iteration's trim/escalation sizing
    // reflects the parent conversation, not the subagent's (#112).
    await executeToolBatch({
      pendingToolCalls,
      messages,
      executeTool: opts.executeTool,
      signal,
      onChunk,
      recentFingerprints,
      budget,
    })

    toolOnlySteps++

    if (signal?.aborted) break
  }

  if (!signal?.aborted && !finishedWithAnswer && !hitRunLimit) {
    // When open todos remain, fire `beforeFinalize` (M0.3) to select closeout
    // nudges so the model reconciles the plan via update_todos — a plain-text
    // "all done" no longer satisfies finalize. Only once the plan is clean (or
    // after closeout gives up) do we fall through to the text-only finalize
    // that produces the user-facing answer.
    const stepCtx: AgentStepContext = {
      provider,
      messages,
      tools,
      onChunk,
      executeTool: opts.executeTool,
      signal,
      budget,
      recentFingerprints,
      ...(getLastUsage !== undefined ? { getLastUsage } : {}),
      ...(usageModel !== undefined ? { usageModel } : {}),
      ...(coerceTextToolCallArgs !== undefined ? { coerceTextToolCallArgs } : {}),
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      toolSchemaReserveTokens,
      ...(onHistoryTrimmed !== undefined ? { onHistoryTrimmed } : {}),
      ...(recordHookRun !== undefined ? { recordHookRun } : {}),
    }

    if (getOpenTodos && hasOpenTodos(getOpenTodos())) {
      const closed = await closeOpenTodosBeforeFinalize(stepCtx, getOpenTodos)
      if (!closed && !signal?.aborted) {
        onChunk({ type: 'text', text: OPEN_TODOS_STILL_OPEN_MESSAGE })
        messages.push({ role: 'assistant', content: OPEN_TODOS_STILL_OPEN_MESSAGE })
      }
    }

    if (!hasOpenTodos(getOpenTodos?.() ?? [])) {
      let finalResult = await streamTextOnlyTurn(
        provider,
        messages,
        onChunk,
        budget,
        FINALIZE_NUDGE,
        getLastUsage,
        usageModel,
        coerceTextToolCallArgs,
      )
      while (finalResult.pendingToolCalls.length > 0 && !runBudgetExhausted(budget)) {
        await executeToolBatch({
          pendingToolCalls: finalResult.pendingToolCalls,
          messages,
          executeTool: opts.executeTool,
          signal,
          onChunk,
          recentFingerprints,
          budget,
        })
        finalResult = await streamTextOnlyTurn(
          provider,
          messages,
          onChunk,
          budget,
          FINALIZE_NUDGE,
          getLastUsage,
          usageModel,
          coerceTextToolCallArgs,
        )
      }
      if (!finalResult.answerText.trim()) {
        onChunk({ type: 'text', text: INCOMPLETE_RUN_MESSAGE })
        messages.push({ role: 'assistant', content: INCOMPLETE_RUN_MESSAGE })
      } else {
        finishedWithAnswer = true
      }
    } else if (getOpenTodos && hasOpenTodos(getOpenTodos())) {
      // Closeout ran its attempts and todos are still open (already noted above);
      // treat the run as finished so we don't also emit the incomplete-run text.
      finishedWithAnswer = true
    }
  }

  const timedOut = hitRunLimit || isAgentRunTimeoutAbort(signal)
  if (timedOut && !finishedWithAnswer) {
    onChunk({ type: 'text', text: RUN_LIMIT_MESSAGE })
    messages.push({ role: 'assistant', content: RUN_LIMIT_MESSAGE })
  }

  // Final guarantee: never leave an assistant tool_use without a matching
  // tool_result in the persisted history. Abort/run-limit breaks can exit the
  // loop right after an assistant tool_use turn was pushed but before its
  // results were appended; this keeps the saved history API-valid for the next
  // turn or resume (#54, #113).
  repairToolUseToolResultPairing(messages)

  onChunk({ type: 'done' })
}
