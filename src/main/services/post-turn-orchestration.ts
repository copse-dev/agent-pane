import { runAgentLoop, type AgentLoopOptions } from '@copse/agent/run-agent-loop.ts'
import {
  PRODUCT_REASONING_CHECKPOINT_POLICY,
  PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
} from '@copse/agent/reasoning-checkpoint-policy.ts'
import type { CoerceToolArgsFn } from '@copse/agent/parse-text-tool-calls.ts'
import type { ContinuationGrant } from '@copse/agent/hooks/continuation-budget.ts'
import {
  buildReviewPrompt,
  parseReviewVerdict,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TOOL_NAMES,
  type ParsedReviewVerdict,
} from '@copse/agent/review-subagent.ts'
import { runSubagent } from '@copse/agent/run-subagent.ts'
import { resolveMaxReviewCycles } from '@copse/agent/plugins/post-turn-review-plugin.ts'
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
import { subagentHookCallbacks } from './hooks/subagent.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { getGitDiffText } from './github/git-service.ts'
import { classifyAgentError } from './agent-errors.ts'

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
  /** Spine-recording sink + step attribution for hooks fired in continuation loops (decision 6). */
  recordHookRun?: AgentLoopOptions['recordHookRun']
  onLlmCall?: AgentLoopOptions['onLlmCall']
  recordStreamCut?: AgentLoopOptions['recordStreamCut']
  recordReasoningCheckpoint?: AgentLoopOptions['recordReasoningCheckpoint']
  /**
   * Shared auto-continuation budget for this turn tree (decision 5). Each
   * pre-review todo attempt consumes one grant, so the gate runs at most
   * `min(MAX_PRE_REVIEW_TODO_ATTEMPTS, remaining)` times — the local cap tightens
   * inside the shared cap.
   */
  continuationBudget?: ContinuationGrant
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
    // Each pre-review attempt is a machine-initiated new turn (decision 5):
    // consume one grant so the local cap tightens inside the shared budget. When
    // the budget is exhausted, the gate stops (the open todos ride into review).
    if (opts.continuationBudget && !opts.continuationBudget.tryGrant()) return
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
    reasoningCheckpointPolicy: PRODUCT_REASONING_CHECKPOINT_POLICY,
    reasoningRunawayTextToleranceChars: PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
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
    ...(opts.recordHookRun !== undefined ? { recordHookRun: opts.recordHookRun } : {}),
    ...(opts.onLlmCall !== undefined ? { onLlmCall: opts.onLlmCall } : {}),
    ...(opts.recordStreamCut !== undefined ? { recordStreamCut: opts.recordStreamCut } : {}),
    ...(opts.recordReasoningCheckpoint !== undefined
      ? { recordReasoningCheckpoint: opts.recordReasoningCheckpoint }
      : {}),
    ...(opts.continuationBudget !== undefined
      ? { continuationBudget: opts.continuationBudget }
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

export interface RunPostTurnReviewOnceOptions {
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
  opts: RunPostTurnReviewOnceOptions,
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
      // D1: the post-turn review subagent goes through the same lifecycle gate
      // as every other subagent spawn — a `subagentStart` deny hook blocks it
      // and `subagentStop` fires on completion (all four runSubagent callers).
      ...subagentHookCallbacks({ usageModel: opts.usageModel }),
    }),
  )

  const verdict = parseReviewVerdict(rawSummary)
  return { summary: verdict.summary, verdict, usage }
}

/**
 * Inputs for the post-turn review + remediation orchestration (E3). The
 * host-interactive gate resolution (review route, spend approval, min-changed
 * lines) stays at the fire site — this function receives the already-resolved
 * booleans and route, so it owns only the *sequencing*: emit the review status
 * chunks, run the read-only review, apply its todo patches, and run bounded
 * remediation cycles while the reviewer asks for follow-up and the parent keeps
 * editing. Each remediation cycle is a machine-initiated new turn (decision 5),
 * so it draws from the shared {@link ContinuationGrant}: the local cap
 * (`maxCycles`, defaulting to `MAX_POST_TURN_REVIEW_CYCLES`) tightens inside the
 * shared budget.
 */
export interface RunPostTurnReviewCycleOptions {
  /** Model id the review runs under (drives the "not approved" skip note). */
  reviewUsageModel: string
  /** Diff below the min-changed-lines threshold — nothing worth a review LLM run. */
  nothingToReview: boolean
  /** Billable-model spend approval result (true for free / local models). */
  reviewApproved: boolean
  signal: AbortSignal
  getTodos: () => TodoItem[]
  setTodos: (todos: TodoItem[]) => void
  /** Emit a `post_turn_review` chunk on the turn's stream. */
  emitChunk: (chunk: StreamChunk) => void
  /** Shared auto-continuation budget for this turn tree (decision 5). */
  continuationBudget: ContinuationGrant
  /**
   * How many review passes this turn may run, from the plugin-scoped
   * `maxReviewCycles` setting. A failing verdict (`requestFollowUp`) buys one
   * remediation turn plus a re-review — i.e. the next pass — so `1` reports a
   * failing review and stops without another turn. Omitted → the shipped
   * {@link MAX_POST_TURN_REVIEW_CYCLES} default; the host resolves the persisted
   * value through `resolveMaxReviewCycles`, and this stays defensive so a
   * caller passing a raw number can't turn the bound into `Infinity` or 0.
   */
  maxCycles?: number
  /**
   * Run one read-only review over `todos` and return its verdict + usage. The
   * host supplies this (it owns the review route, provider, and usage plumbing);
   * the cycle only owns the sequencing. Contract tests inject a deterministic
   * verdict so the budget / remediation loop is pinned without a provider.
   */
  runReviewOnce: (todos: readonly TodoItem[]) => Promise<PostTurnReviewOutcome>
  /**
   * Run one parent remediation continuation turn seeded with `nudge`, returning
   * whether it edited files. The host supplies this (it owns read-file limits and
   * the turn-changed-files flag the auto-comparison trigger reads); the cycle only
   * decides *whether* to run one and stops when it makes no edits.
   */
  runRemediationTurn: (nudge: string) => Promise<{ madeEdits: boolean }>
  /**
   * Observe a review verdict as it is produced (F2). Called once per review
   * `done` — never on a skip (empty diff / spend not approved) or error — so the
   * host can fire the Copse-native `postTurnReview` hook without this pure
   * orchestration importing hook services (execution-guidance rule 4). Optional:
   * the contract tests inject nothing and the cycle behaves as before.
   */
  onReviewVerdict?: (review: PostTurnReviewOutcome) => void
}

/**
 * Post-turn review + bounded remediation (E3). Runs after the main agent loop
 * (and the pre-review todo gate) at the turn boundary, before the run's single
 * terminal `done` — the thread stays "running" because this is awaited inline,
 * not because a `done` chunk is held back (E3 deletes that deferred-`done`
 * dance). Emits the same `post_turn_review` chunk sequence the inline mechanism
 * did, so the UI is byte-identical.
 */
export async function runPostTurnReviewCycle(opts: RunPostTurnReviewCycleOptions): Promise<void> {
  if (opts.nothingToReview) {
    opts.emitChunk({
      type: 'post_turn_review',
      status: 'skipped',
      summary: 'Nothing to review in the working diff.',
    })
    return
  }
  if (!opts.reviewApproved) {
    opts.emitChunk({
      type: 'post_turn_review',
      status: 'skipped',
      summary: opts.signal.aborted
        ? 'Review cancelled.'
        : `Review skipped — spending on ${opts.reviewUsageModel} was not approved.`,
    })
    return
  }

  const maxCycles = resolveMaxReviewCycles(opts.maxCycles)
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    opts.emitChunk({ type: 'post_turn_review', status: 'running', summary: '' })
    try {
      const review = await opts.runReviewOnce(opts.getTodos())

      const todosAfterReview = applyReviewTodoUpdates(opts.getTodos(), review.verdict)
      if (todosAfterReview.length > 0 || opts.getTodos().length > 0) {
        opts.setTodos(todosAfterReview)
      }

      opts.emitChunk({
        type: 'post_turn_review',
        status: 'done',
        summary: review.summary,
        issuesFound: review.verdict.issuesFound,
      })

      // F2: let the host observe the verdict and fire the Copse-native
      // `postTurnReview` hook (detached). Fired only for a real `done`, so a
      // skipped / errored review never emits the event.
      opts.onReviewVerdict?.(review)

      const lastCycle = cycle >= maxCycles - 1
      if (!review.verdict.requestFollowUp || lastCycle || opts.signal.aborted) break

      // A remediation cycle is a machine-initiated new turn (decision 5): consume
      // one grant from the shared budget before running it. The local cap
      // (`maxCycles`, from the plugin's `maxReviewCycles` setting) tightens inside
      // the shared cap — once the budget is exhausted, no further remediation runs.
      if (!opts.continuationBudget.tryGrant()) break

      const { madeEdits } = await opts.runRemediationTurn(
        buildReviewRemediationNudge(review.verdict),
      )
      if (!madeEdits) break
    } catch (err) {
      const detail = opts.signal.aborted ? 'Review cancelled.' : classifyAgentError(err)
      opts.emitChunk({ type: 'post_turn_review', status: 'error', summary: detail })
      break
    }
  }
}

export { MAX_POST_TURN_REVIEW_CYCLES }
