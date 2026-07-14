import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { CoerceToolArgsFn } from '@copse/agent/parse-text-tool-calls.ts'
import {
  buildReviewPrompt,
  parseReviewVerdict,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TOOL_NAMES,
  type ParsedReviewVerdict,
} from '@copse/agent/review-subagent.ts'
import { runSubagent } from '@copse/agent/run-subagent.ts'
import { conversationTokenBudget } from '@copse/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@copse/agent/read-file-limits.ts'
import { hasOpenTodos } from '@copse/agent/agent-loop-guards.ts'
import {
  applyTodoUpdate,
  MAX_POST_TURN_REVIEW_CYCLES,
  MAX_PRE_REVIEW_TODO_ATTEMPTS,
  OPEN_TODOS_PRE_REVIEW_NUDGE,
  OPEN_TODOS_REVIEW_REMEDIATION_NUDGE,
} from '@shared/todos/todo-logic.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ModelUsage,
  StreamChunk,
  ToolExecuteResult,
} from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ToolRegistry } from './tool-registry.ts'
import { runWithAgentRunReadFileLimits } from './agent-run-read-limits.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { getGitDiffText } from './github/git-service.ts'

export interface PostTurnReviewOutcome {
  summary: string
  verdict: ParsedReviewVerdict
  usage: ModelUsage
}

export interface RunParentContinuationOptions {
  provider: LLMProvider
  messages: LLMMessage[]
  tools: LLMTool[]
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  usageModel: string
  onChunk: (chunk: StreamChunk) => void
  getOpenTodos: () => TodoItem[]
  setTodos: (todos: TodoItem[]) => void
  userNudge: string
  maxSteps: number
  executeTool: (
    name: string,
    args: unknown,
    signal: AbortSignal,
    toolCallId: string,
  ) => Promise<ToolExecuteResult>
  onHistoryTrimmed?: () => void
  getLastUsage?: () => { inputTokens: number; outputTokens: number } | null
  coerceTextToolCallArgs?: CoerceToolArgsFn
  onEditTool?: (name: string) => void
}

function filterReviewTools(registry: ToolRegistry): LLMTool[] {
  const names = new Set<string>(REVIEW_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

function executeReviewTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!(REVIEW_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Tool not allowed in review subagent: ${name}`)
  }
  return registry.execute(name, args, signal)
}

/** Deterministic parent continuation when todos are still open before review. */
export async function runPreReviewTodoGate(opts: RunParentContinuationOptions): Promise<void> {
  for (let attempt = 0; attempt < MAX_PRE_REVIEW_TODO_ATTEMPTS; attempt++) {
    if (!hasOpenTodos(opts.getOpenTodos())) return
    await runParentContinuationTurn({
      ...opts,
      userNudge: OPEN_TODOS_PRE_REVIEW_NUDGE,
    })
    if (opts.signal.aborted) return
  }
}

/** One parent agent loop seeded with a synthetic user nudge. */
export async function runParentContinuationTurn(opts: RunParentContinuationOptions): Promise<void> {
  opts.messages.push({ role: 'user', content: opts.userNudge })
  await runAgentLoop({
    provider: opts.provider,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: opts.maxSteps,
    maxContextTokens: opts.contextWindow,
    toolSchemaReserveTokens: opts.toolSchemaReserve,
    signal: opts.signal,
    usageModel: opts.usageModel,
    onChunk: opts.onChunk,
    getOpenTodos: opts.getOpenTodos,
    ...(opts.onHistoryTrimmed !== undefined ? { onHistoryTrimmed: opts.onHistoryTrimmed } : {}),
    ...(opts.getLastUsage !== undefined ? { getLastUsage: opts.getLastUsage } : {}),
    ...(opts.coerceTextToolCallArgs !== undefined
      ? { coerceTextToolCallArgs: opts.coerceTextToolCallArgs }
      : {}),
    executeTool: async (name, args, signal, toolCallId) => {
      opts.onEditTool?.(name)
      return opts.executeTool(name, args, signal, toolCallId)
    },
  })
}

export function applyReviewTodoUpdates(
  current: readonly TodoItem[],
  verdict: ParsedReviewVerdict,
): TodoItem[] {
  if (verdict.todoUpdates.length === 0) return [...current]
  return applyTodoUpdate(current, verdict.todoUpdates, true)
}

/**
 * Body for the "review this diff with a paid model?" approval prompt (#584). Kept
 * pure so it's unit-testable; the caller supplies the resolved review model id.
 */
export function reviewSpendApprovalBody(reviewModel: string): string {
  return [
    `Review the working diff after each editing turn using ${reviewModel}?`,
    '',
    'This makes billable calls to that model on every turn that changes files.',
    'Set a local review model in Settings to review for free instead.',
  ].join('\n')
}

export function buildReviewRemediationNudge(verdict: ParsedReviewVerdict): string {
  const parts = [OPEN_TODOS_REVIEW_REMEDIATION_NUDGE]
  if (verdict.followUpPrompt) {
    parts.push('', verdict.followUpPrompt)
  } else if (verdict.summary.trim()) {
    parts.push('', 'Review findings:', verdict.summary.trim())
  }
  return parts.join('\n')
}

export interface RunPostTurnReviewCycleOptions {
  parentGoal: string
  todos: readonly TodoItem[]
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  usageModel: string
  onUsage: (usage: ModelUsage) => void
}

export async function runPostTurnReviewOnce(
  opts: RunPostTurnReviewCycleOptions,
): Promise<PostTurnReviewOutcome> {
  const workspace = getWorkspaceRoot() ?? '(none)'
  const diff = await getGitDiffText()
  const prompt = buildReviewPrompt(opts.parentGoal, diff, opts.todos)

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, opts.contextWindow, {
    reserveTokens: opts.toolSchemaReserve,
  })
  const subagentReadLimits = readFileLimitsForSubagent(subagentBudget)

  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
  const onSubagentChunk = (chunk: StreamChunk): void => {
    if (chunk.type === 'usage') {
      usage = {
        inputTokens: usage.inputTokens + chunk.inputTokens,
        outputTokens: usage.outputTokens + chunk.outputTokens,
      }
      opts.onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
    }
  }

  const { summary: rawSummary } = await runWithAgentRunReadFileLimits(subagentReadLimits, () =>
    runSubagent({
      provider: opts.provider,
      prompt,
      parentGoal: `${opts.parentGoal}\nWorkspace: ${workspace}`,
      tools: filterReviewTools(opts.registry),
      parentToolCallId: 'post-turn-review',
      signal: opts.signal,
      maxContextTokens: opts.contextWindow,
      toolSchemaReserveTokens: opts.toolSchemaReserve,
      executeTool: (name, args, sig) => executeReviewTool(opts.registry, name, args, sig),
      onSubagentChunk,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userTask: prompt,
      usageModel: opts.usageModel,
    }),
  )

  const verdict = parseReviewVerdict(rawSummary)
  return { summary: verdict.summary, verdict, usage }
}

export { MAX_POST_TURN_REVIEW_CYCLES }
