import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  StreamChunk,
  ToolCallChunk,
  ToolResult,
  ToolExecuteResult,
} from '@shared/types'
import { normalizeToolExecuteResult } from '@shared/types'
import {
  trimMessagesInPlace,
  repairToolUseToolResultPairing,
  CANCELLED_TOOL_RESULT,
  setLastMeasuredInputTokens,
} from './trim-history.ts'
import type { TodoItem } from '@shared/types/todo.ts'
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
  REFUSAL_USER_MESSAGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '../llm/provider-stop-reason.ts'
import {
  AGENT_RUN_TIMEOUT_MS,
  defaultMaxLlmCallsForSteps,
  isRunPastDeadline,
} from './agent-loop-limits.ts'
import { hasOpenTodos, OPEN_TODOS_FINALIZE_NUDGE } from '@shared/todos/todo-logic.ts'

const RECENT_FINGERPRINT_WINDOW = 16
/** Do not compact on the first tool round unless the transcript is critically full. */
const TRIM_CRITICAL_FILL = 0.95
/** After this many tool rounds, always allow normal in-loop compaction. */
const TRIM_DEFER_MAX_TOOL_STEPS = 2

export interface AgentLoopOptions {
  provider: LLMProvider
  messages: LLMMessage[] // mutated in-place as turns are added
  tools: LLMTool[]
  onChunk: (chunk: StreamChunk) => void
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
  /** Wall-clock budget checked alongside maxLlmCalls. */
  runTimeoutMs?: number
  /** Coerce recovered XML tool args against registered tool schemas. */
  coerceTextToolCallArgs?: CoerceToolArgsFn
  /** When set, finalize is blocked while todos remain open. */
  getOpenTodos?: () => readonly TodoItem[]
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
  runStartedAt: number
  runTimeoutMs: number
  signal?: AbortSignal
}

function runBudgetExhausted(budget: LlmCallBudget): boolean {
  if (isRunPastDeadline(budget.runStartedAt, budget.runTimeoutMs)) return true
  if (budget.llmCalls >= budget.maxLlmCalls) return true
  return false
}

function reserveLlmCall(budget: LlmCallBudget): boolean {
  if (runBudgetExhausted(budget)) return false
  budget.llmCalls++
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
  onChunk: (chunk: StreamChunk) => void,
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
  onChunk: (chunk: StreamChunk) => void,
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

async function streamTextOnlyTurn(
  provider: LLMProvider,
  messages: LLMMessage[],
  onChunk: (chunk: StreamChunk) => void,
  budget: LlmCallBudget,
  nudge = FINALIZE_NUDGE,
  getLastUsage?: () => { inputTokens: number; outputTokens: number } | null,
  usageModel?: string,
): Promise<string> {
  if (!reserveLlmCall(budget)) return ''
  const signal = budget.signal
  const turnMessages: LLMMessage[] = [...messages, { role: 'user', content: nudge }]
  let assistantText = ''
  let stopReason: string | undefined
  let streamUsage: StepUsage | null = null

  for await (const chunk of provider.stream(turnMessages, [], signal)) {
    if (signal?.aborted) break
    if (chunk.type === 'text') {
      assistantText += chunk.text
      onChunk(chunk)
    }
    if (chunk.type === 'usage') {
      streamUsage = {
        inputTokens: chunk.inputTokens,
        outputTokens: chunk.outputTokens,
        ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
        ...(chunk.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: chunk.cacheCreationTokens }
          : {}),
      }
    }
    if (chunk.type === 'done') {
      stopReason = chunk.stopReason
      break
    }
  }

  const trimmed = assistantText.trim()
  if (isRefusalStopReason(stopReason)) {
    const text = trimmed || REFUSAL_USER_MESSAGE
    if (!trimmed) onChunk({ type: 'text', text })
    messages.push({ role: 'assistant', content: text })
    emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)
    return text
  }
  if (trimmed) {
    messages.push({ role: 'assistant', content: assistantText })
  } else if (isTruncationStopReason(stopReason)) {
    messages.push({ role: 'user', content: TRUNCATION_CONTINUE_NUDGE })
  }
  emitStepUsage(streamUsage, getLastUsage, onChunk, usageModel)
  return trimmed
}

function handleContextOverflowInLoop(
  messages: LLMMessage[],
  maxContextTokens: number | undefined,
  toolSchemaReserveTokens: number,
  tools: LLMTool[],
  onChunk: (chunk: StreamChunk) => void,
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
    runTimeoutMs = AGENT_RUN_TIMEOUT_MS,
    coerceTextToolCallArgs,
    getOpenTodos,
  } = opts
  const budget: LlmCallBudget = {
    llmCalls: 0,
    maxLlmCalls,
    runStartedAt: Date.now(),
    runTimeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  }
  let steps = 0
  let finishedWithAnswer = false
  let hitRunLimit = false
  let toolOnlySteps = 0
  let loopNudgeSent = false
  let forceTextAttempted = false
  let trimEvents = 0
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

      if (
        !finishedWithAnswer &&
        !forceTextAttempted &&
        shouldForceTextAnswer(escalationInput, pressure)
      ) {
        forceTextAttempted = true
        const forced = await streamTextOnlyTurn(
          provider,
          messages,
          onChunk,
          budget,
          STUCK_FINALIZE_NUDGE,
          getLastUsage,
          usageModel,
        )
        if (forced.trim()) {
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

    for await (const chunk of provider.stream(messages, tools, signal)) {
      if (signal?.aborted) break
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
      if (chunk.type === 'done') {
        stopReason = chunk.stopReason
        break
      }
    }

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

    if (pendingToolCalls.length === 0 && /<\s*tool_call\s*>/i.test(assistantText)) {
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
    }

    // Push assistant message to history
    if (pendingToolCalls.length > 0) {
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

    // Execute tools and collect results
    const toolResults: ToolResult[] = []
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
      // Provider could not parse the streamed tool-call arguments. Do not run
      // the tool with empty/partial args — return an error so the model retries
      // the call with well-formed JSON (#114).
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
        const raw = duplicate
          ? DUPLICATE_TOOL_RESULT_PREFIX
          : await opts.executeTool(
              tc.name,
              normalizedArgs,
              signal ?? new AbortController().signal,
              tc.id,
            )
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
        const msg = err instanceof Error ? err.message : String(err)
        toolResults.push({ toolCallId: tc.id, result: `Error: ${msg}` })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result: `Error: ${msg}`, isError: true })
      }
    }

    toolOnlySteps++

    if (toolResults.length > 0) {
      messages.push({ role: 'tool', toolResults })
    }

    if (signal?.aborted) break
  }

  if (!signal?.aborted && !finishedWithAnswer && !hitRunLimit) {
    const openTodos = getOpenTodos?.() ?? []
    const nudge =
      openTodos.length > 0 && hasOpenTodos(openTodos) ? OPEN_TODOS_FINALIZE_NUDGE : FINALIZE_NUDGE
    const finalText = await streamTextOnlyTurn(
      provider,
      messages,
      onChunk,
      budget,
      nudge,
      getLastUsage,
      usageModel,
    )
    if (!finalText.trim()) {
      onChunk({ type: 'text', text: INCOMPLETE_RUN_MESSAGE })
      messages.push({ role: 'assistant', content: INCOMPLETE_RUN_MESSAGE })
    } else {
      finishedWithAnswer = true
    }
  }

  if (hitRunLimit && !finishedWithAnswer && !signal?.aborted) {
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
