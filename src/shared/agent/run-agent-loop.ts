import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  StreamChunk,
  ToolCallChunk,
  ToolResult,
} from '@shared/types'
import { trimMessagesInPlace } from './trim-history.ts'
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
  executeTool: (name: string, args: unknown, signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
  maxSteps?: number
  /** Trim in-loop history to this context size (tokens). */
  maxContextTokens?: number
  /** Reserve headroom for tool JSON schemas on each provider call. */
  toolSchemaReserveTokens?: number
  onHistoryTrimmed?: () => void
}

const FINALIZE_NUDGE =
  'Based on your exploration so far, write a clear final answer for the user. Do not call any tools.'

const INCOMPLETE_RUN_MESSAGE =
  'The agent stopped before producing a final answer. Try a shorter question, reduce tool use, or switch models.'

async function streamTextOnlyTurn(
  provider: LLMProvider,
  messages: LLMMessage[],
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal,
  nudge = FINALIZE_NUDGE,
): Promise<string> {
  const turnMessages: LLMMessage[] = [...messages, { role: 'user', content: nudge }]
  let assistantText = ''

  for await (const chunk of provider.stream(turnMessages, [], signal)) {
    if (signal?.aborted) break
    if (chunk.type === 'text') {
      assistantText += chunk.text
      onChunk(chunk)
    }
    if (chunk.type === 'done') break
  }

  const trimmed = assistantText.trim()
  if (trimmed) {
    messages.push({ role: 'assistant', content: assistantText })
  }
  return trimmed
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
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
  } = opts
  let steps = 0
  let finishedWithAnswer = false
  let toolOnlySteps = 0
  let loopNudgeSent = false
  let forceTextAttempted = false
  let trimEvents = 0
  const recentFingerprints: string[] = []

  while (steps < maxSteps) {
    if (signal?.aborted) break
    steps++

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
          signal,
          STUCK_FINALIZE_NUDGE,
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
      if (chunk.type === 'done') break
    }

    if (signal?.aborted) break

    // Push assistant message to history
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      })
    } else if (assistantText.trim()) {
      messages.push({ role: 'assistant', content: assistantText })
      finishedWithAnswer = true
      break
    } else {
      // Empty turn (common when context is tight) — keep looping instead of exiting early.
      continue
    }

    // Execute tools and collect results
    const toolResults: ToolResult[] = []
    for (const tc of pendingToolCalls) {
      if (signal?.aborted) break
      const normalizedArgs = normalizeExploreArgs(tc.name, tc.args)
      const fp = toolCallFingerprint(tc.name, normalizedArgs)
      const duplicate = isDuplicateExploreCall(tc.name, normalizedArgs, recentFingerprints)
      recentFingerprints.push(fp)
      if (recentFingerprints.length > RECENT_FINGERPRINT_WINDOW) {
        recentFingerprints.shift()
      }

      try {
        const result = duplicate
          ? DUPLICATE_TOOL_RESULT_PREFIX
          : await opts.executeTool(tc.name, normalizedArgs, signal ?? new AbortController().signal)
        toolResults.push({ toolCallId: tc.id, result })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result, isError: false })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toolResults.push({ toolCallId: tc.id, result: `Error: ${msg}` })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result: `Error: ${msg}`, isError: true })
      }
    }

    toolOnlySteps++

    if (signal?.aborted) break

    // Push tool results to history
    messages.push({ role: 'tool', toolResults })
  }

  if (!signal?.aborted && !finishedWithAnswer) {
    const finalText = await streamTextOnlyTurn(provider, messages, onChunk, signal)
    if (!finalText.trim()) {
      onChunk({ type: 'text', text: INCOMPLETE_RUN_MESSAGE })
      messages.push({ role: 'assistant', content: INCOMPLETE_RUN_MESSAGE })
    } else {
      finishedWithAnswer = true
    }
  }

  onChunk({ type: 'done' })
}
