import { errorMessage } from '@shared/errors.ts'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import {
  createAgentRunAbortScheduler,
  DEFAULT_MAX_LLM_CALLS,
} from '@copse/agent/agent-loop-limits.ts'
import {
  normalizeToolExecuteResult,
  type LLMMessage,
  type LLMTool,
  type StreamChunk,
  type ToolExecuteResult,
  type UserContent,
} from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { getSetting } from './storage/settings.ts'
import { resetSessionBackup } from './worktree-backup.ts'
import { resolveContextWindow } from './providers/resolve-context-window.ts'
import { classifyAgentError } from './agent-errors.ts'
import { resolveParentGoal } from '@copse/agent/working-brief.ts'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { hasLastUsage } from './providers/provider-usage.ts'
import {
  clearActiveRunThread,
  recordThreadModel,
  setActiveRunModel,
  setActiveRunThread,
} from './thread-models.ts'
import { createAgentChunkSink } from './agent-chunk-sink.ts'
import { redactUserContent } from './security/pii-redactor.ts'
import { createHookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import {
  beginHookRunRecording,
  endHookRunRecording,
  recordFunctionHookRun,
  snapshotHookRunContext,
  setHookRunStep,
  setHookRunToolset,
} from './hook-run-recorder.ts'
import {
  buildProvider,
  buildSubagentRoute,
  buildReviewRoute,
  isBillableModel,
  isLocalChatModel,
} from './providers/provider-selection.ts'
import { requestApproval } from './approval.ts'
import {
  applyReviewTodoUpdates,
  buildReviewRemediationNudge,
  MAX_POST_TURN_REVIEW_CYCLES,
  reviewSpendApprovalBody,
  runParentContinuationTurn,
  runPostTurnReviewOnce,
  runPreReviewTodoGate,
  type RunParentContinuationOptions,
} from './post-turn-orchestration.ts'
import { runPostTurnReview } from './review-subagent-runner.ts'
import { isEditTool } from '@copse/agent/review-subagent.ts'
import { hasOpenTodos } from '@copse/agent/agent-loop-guards.ts'
import {
  prepareAgentHistory,
  contextTrimmedChunk,
  contextPressureChunk,
  createTrimNotifier,
  promptExceedsContextWindow,
  oversizedTurnMessage,
} from './history-trimming.ts'
import {
  runWithAgentRunReadFileLimits,
  getAgentRunReadFileLimits,
  readFileLimitsFromConversationBudget,
} from './agent-run-read-limits.ts'
import { runWithAgentRunReadonly } from './agent-run-readonly.ts'
import { isToolAllowedInReadonlyMode } from '@shared/tools/readonly-tools.ts'
import { getMcpToolMeta } from './mcp/mcp-registry.ts'
import { formatReadFileLimitHint } from '@copse/agent/read-file-limits.ts'
import { runWithExploreSubagentContext } from './explore-subagent-runner.ts'
import { setCurrentShellTaskId } from './exec/shell-output-context.ts'
import { setCiInvestigatorContext } from './ci-investigator-runner.ts'
import { resolveAdvisorModelId } from './advisor-runner.ts'
import { runWithAdvisorContext } from './advisor-runner-context.ts'
import { advisorAddsLift } from './advisor-strategy.ts'
import {
  runWithOrchestrationContext,
  resolveOrchestrationWorkerModelId,
} from './orchestration-runner.ts'
import {
  runModelComparison,
  setModelComparisonContext,
  isAutoComparisonEnabled,
} from './model-comparison-runner.ts'
import { resetSubagentUsage, getAccumulatedSubagentUsage } from './subagent-usage.ts'
import {
  setAgentRunTodoContext,
  clearAgentRunTodos,
  getAgentRunTodos,
  setAgentRunTodos,
} from './agent-run-todos.ts'
import { getGithubRepoSlug, getGitDiffText, countDiffChangedLines } from './github/git-service.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { isWorkspaceTrusted } from './security/workspace-trust.ts'
import { runBeforeSubmitPromptHooks } from './hooks/before-submit-prompt.ts'
import { runStopHooks } from './hooks/stop.ts'
import { runAfterToolUseHooks } from './hooks/after-tool-use.ts'
import { asTurnTreeId, type TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { ContinuationGrant } from '@copse/agent/hooks/continuation-budget.ts'
import { currentAgentSessionInfo } from './hooks/agent-session.ts'
import { getContinuationLedger } from './hooks/continuation-ledger.ts'
import { isGitAvailable } from './tool-availability.ts'
import {
  findNewlyInProgressLocal,
  findNewlyCompleted,
  shouldRouteToLocal,
} from '@shared/todos/todo-logic.ts'
import { compactAtTodoBoundary } from '@shared/todos/todo-context.ts'
import { setTodoToolPostProcess } from '../tools/todo-tool.ts'
import { runTodoWorker } from './todo-worker-runner.ts'
import { verifyTodoCheck } from './todo-verification.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import { parseRemoteAgentModelSelection } from '@shared/remote-agent.ts'
import { runRemoteAgentFromSettings } from './remote/remote-agent-client.ts'
import { resolveAgentChatModel } from './providers/resolve-agent-model.ts'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { AcpTurnFailure, runAcpAgentFromSettings } from './acp/acp-agent-service.ts'
import { SUBAGENTS_ENABLED_DEFAULT, SUBAGENTS_ENABLED_SETTING } from './subagents-setting.ts'

// Re-export the public surface so existing IPC/test imports stay stable while the
// implementation lives in focused modules.
export {
  isLocalChatModel,
  buildSubagentRoute,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
  testLmStudio,
} from './providers/provider-selection.ts'
export {
  suggestThreadTitle,
  suggestTerminalTitle,
  suggestCommandSummary,
} from './title-generator.ts'

const abortMap = new Map<string, AbortController>()

// LM Studio models advertise smaller tool-schema budgets than cloud providers,
// so reserve more of the window for their tool definitions. Shared by the turn
// path and the standalone review/comparison retries below.
function toolSchemaReserveForModel(model: string): number {
  return model === 'lm-studio' || model.startsWith('lmstudio:') ? 2_500 : 1_000
}

/**
 * True when the working diff the post-turn review would consume has fewer than
 * `min` changed lines. Drives the review "nothing to review" gate (#584): with the
 * default threshold of 1 this skips only an empty diff (e.g. right after a commit),
 * and a larger threshold additionally skips trivial edits. Measures the exact diff
 * the review sees — `getGitDiffText()` (unstaged tracked changes + untracked new
 * files) — so a turn that only adds a large new file is NOT wrongly skipped (its
 * additions live in that diff even though `git diff --numstat` omits them). An
 * unmeasurable diff (git unavailable) falls through to running the review.
 */
async function changedLinesBelow(min: number): Promise<boolean> {
  if (!isGitAvailable()) return false
  const diff = await getGitDiffText()
  return countDiffChangedLines(diff) < min
}

// Threads whose user approved spending on the post-turn review ("always review
// with this model in this chat"). Per-thread, not process-global, so approving a
// billable review in one project never silently authorizes it in another — the
// same cross-project prompt-leakage guard the model-comparison approval uses.
const approvedReviewThreads = new Set<string>()

/**
 * Gate a billable post-turn review behind a spend approval, remembered per thread
 * (#584). Non-billable review models never reach here. Returns false when declined
 * or the run was cancelled; the abort signal is checked around the modal so a Stop
 * press mid-prompt doesn't start a billable review for an aborted turn.
 */
async function ensureReviewApproved(
  reviewModel: string,
  threadId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (approvedReviewThreads.has(threadId)) return true
  if (signal.aborted) return false
  const { approved, remember } = await requestApproval({
    type: 'review-spend',
    title: 'Review this diff with a paid model?',
    body: reviewSpendApprovalBody(reviewModel),
    allowRemember: true,
    rememberLabel: 'Always review with this model in this chat',
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can flip during the awaited approval; TS narrows it from the guard above
  if (signal.aborted) return false
  if (approved && remember) approvedReviewThreads.add(threadId)
  return approved
}

export const PARENT_DELEGATED_TOOLS = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'find_files',
] as const

/** Tools that only function as subagent entry points; hidden when subagents are off. */
const SUBAGENT_ENTRY_TOOLS = new Set<string>(['explore', 'investigate_ci'])

function parentTools(
  registry: ToolRegistry,
  subagentsEnabled: boolean,
  readonlyMode: boolean,
  executorModel: string,
): LLMTool[] {
  let tools = registry.toLLMTools()
  // Hide the advisor tool when the configured advisor is not more capable than
  // the executor (same model, or a confidently weaker annotated pairing) — it
  // would only spend tokens for no lift. Conservative: cross-scale/unannotated
  // pairings keep it (see advisorAddsLift). No-op unless the tool is registered.
  if (
    tools.some((t) => t.name === 'advisor') &&
    !advisorAddsLift(executorModel, resolveAdvisorModelId())
  ) {
    tools = tools.filter((t) => t.name !== 'advisor')
  }
  if (!subagentsEnabled) {
    tools = tools
      .filter((t) => !SUBAGENT_ENTRY_TOOLS.has(t.name))
      .map((t) =>
        t.name === 'read_file'
          ? {
              ...t,
              description: `Read a file from the workspace. ${formatReadFileLimitHint(
                getAgentRunReadFileLimits(),
              )}; use start_line / end_line for more.`,
            }
          : t,
      )
  } else {
    const excluded = new Set<string>(PARENT_DELEGATED_TOOLS)
    tools = tools.filter((t) => !excluded.has(t.name))
  }
  // Keep the offered tool set equal to the allowed set so the model never wastes
  // turns calling a tool that read-only enforcement would reject.
  if (readonlyMode) {
    tools = tools.filter((t) =>
      isToolAllowedInReadonlyMode(t.name, {
        mcpAnnotations: t.name.startsWith('mcp__')
          ? getMcpToolMeta(t.name)?.annotations
          : undefined,
      }),
    )
  }
  return tools
}

/** The composed prompt text a `beforeSubmitPrompt` hook receives (Cursor `prompt`). */
function promptTextForSubmit(userPrompt: UserContent): string {
  if (typeof userPrompt === 'string') return userPrompt
  return userPrompt
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Fire `beforeSubmitPrompt` (B1). Returns the user-facing notice to show when a
 * hook halted the submit (`continue: false`), or null to proceed. Recording is
 * begun/ended around the fire so a halting hook's `hook_run` line is attributed
 * to this thread (decision 6); the turn itself re-begins recording with its own
 * turn id.
 */
async function runBeforeSubmitPrompt(
  threadId: string,
  userPrompt: UserContent,
): Promise<string | null> {
  // Gate on the same master switch as every other hook path (tool gate, stop,
  // afterFileEdit). Without this, "always-trusted" user `~/.cursor/hooks.json`
  // beforeSubmitPrompt hooks would spawn on every submit even with the feature
  // off (the default) — a consent-gate bypass and needless per-submit discovery.
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return null
  const workspaceRoot = getWorkspaceRoot()
  beginHookRunRecording(threadId)
  try {
    const decision = await runBeforeSubmitPromptHooks(promptTextForSubmit(userPrompt), {
      workspaceRoot,
      projectTrusted: isWorkspaceTrusted(workspaceRoot),
      // Real conversation/generation ids + running model on the wire payload (B4).
      agentSession: currentAgentSessionInfo({ conversationId: threadId }),
    })
    if (!decision.blocked) return null
    return (
      decision.userMessage ?? decision.reason ?? 'A hook blocked this prompt from being submitted.'
    )
  } finally {
    endHookRunRecording(threadId)
  }
}

/**
 * Fire `stop` (B3) the moment agent work stops — turn end or abort. **Detached,
 * never awaited (decision 3, no drain barrier):** dispatched with `void` so a
 * slow `stop` hook can never delay the turn's `done`, and abort halts emission
 * of new events but never waits for in-flight hooks. Gated behind
 * `cursorHooksEnabled` (default off) at the fire site, the same flag the
 * tool-gate / afterFileEdit paths use, because honouring hooks spawns
 * user/project scripts. Any dispatch error is swallowed — a broken stop hook
 * can never fail the turn that already finished.
 */
function fireStopHook(
  threadId: string,
  status: 'completed' | 'aborted',
  runTurnTreeId?: TurnTreeId,
): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  const workspaceRoot = getWorkspaceRoot()
  // Capture the agent-session identity **by value** now, synchronously — `stop`
  // dispatches detached (decision 3) and the run's recording context is torn
  // down right after, so reading ambient ids at marshal time would come up empty
  // (B4). The snapshot lets the detached hook still stamp the finished turn.
  const agentSession = currentAgentSessionInfo()
  // C3 unifies the epoch: the run carries the renderer-minted turn-tree id
  // (decision 16), so a `stop` hook's queued follow-up is tagged with the same
  // epoch the renderer's staleness check compares against. Fall back to the run's
  // generation id, then the thread id, when no renderer epoch was threaded (e.g.
  // an older client, ACP, or a standalone retry).
  const turnTreeId = runTurnTreeId ?? asTurnTreeId(agentSession.generationId || threadId)
  // Snapshot the recording context now, synchronously (C1): `endHookRunRecording`
  // clears the live context right after this fire site, so the detached stop hook
  // records against the snapshot (decision 3/6) or its hook_run line would be lost.
  const recordingSnapshot = snapshotHookRunContext()
  void runStopHooks(status, {
    threadId,
    turnTreeId,
    workspaceRoot,
    projectTrusted: isWorkspaceTrusted(workspaceRoot),
    agentSession,
    recordingSnapshot,
  }).catch((err: unknown) => {
    console.warn('[hooks] stop hook dispatch error:', errorMessage(err))
  })
}

/**
 * Fire `afterToolUse` (D2) after a tool result — the canonical post-tool
 * observation. Cursor's `afterShellExecution` / `afterMCPExecution` are payload
 * flavors chosen by the tool name; discovery yields no hooks for other tools, so
 * firing generically for every result is cheap and only shell/MCP hooks run.
 *
 * **Detached, never awaited (decision 3, no drain barrier):** dispatched with
 * `void` so a slow observation hook can never delay the agent loop. Gated behind
 * `cursorHooksEnabled` (default off) at the fire site — the same flag the
 * tool-gate / stop paths use — because honouring a hook spawns a user/project
 * script. Any dispatch error is swallowed: a broken observation hook can never
 * fail the tool call that already produced its result. The output snapshot is
 * capped by `runAfterToolUseHooks` before it reaches a hook's stdin.
 */
function fireAfterToolUseHook(args: {
  threadId: string
  turnTreeId: TurnTreeId
  toolName: string
  toolCallId: string
  isError: boolean
  input: unknown
  output: string
  durationMs: number
}): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  const workspaceRoot = getWorkspaceRoot()
  // Capture the agent-session identity by value now — the hook dispatches
  // detached (decision 3) and may marshal after this turn's recording context is
  // torn down (B4).
  const agentSession = currentAgentSessionInfo()
  // Snapshot the recording context now, synchronously, like `fireStopHook`: a
  // detached `afterToolUse` hook may settle after `endHookRunRecording` clears
  // the live context, and its `hook_run` line must still attribute to the
  // emitting turn (decision 3/6).
  const recordingSnapshot = snapshotHookRunContext()
  const input =
    typeof args.input === 'object' && args.input !== null
      ? (args.input as Record<string, unknown>)
      : undefined
  void runAfterToolUseHooks(
    {
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      isError: args.isError,
      ...(input ? { input } : {}),
      output: args.output,
      durationMs: args.durationMs,
    },
    {
      threadId: args.threadId,
      turnTreeId: args.turnTreeId,
      workspaceRoot,
      projectTrusted: isWorkspaceTrusted(workspaceRoot),
      agentSession,
      recordingSnapshot,
    },
  ).catch((err: unknown) => {
    console.warn('[hooks] afterToolUse hook dispatch error:', errorMessage(err))
  })
}

export async function runAgent(
  threadId: string,
  userPrompt: UserContent,
  priorMessages: LLMMessage[],
  host: AgentHost<StreamChunk>,
  registry: ToolRegistry,
  options?: {
    invokedSkills?: string[]
    priorTodos?: TodoItem[]
    workingBrief?: string
    model?: string
    /** Turn-tree epoch this run belongs to (decision 16 / C3); keys the budget. */
    turnTreeId?: string
    /** Machine turns already spent in this turn tree (decision 5); seeds the budget. */
    continuationBudgetUsed?: number
  },
): Promise<{ usage: { inputTokens: number; outputTokens: number }; messages: LLMMessage[] }> {
  // A new turn: drop last turn's restore point so the next dirty-worktree edit
  // snapshots the user's current uncommitted work before applying over it.
  resetSessionBackup()

  const requestedModel = options?.model ?? getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const resolved = await resolveAgentChatModel(requestedModel)
  const model = resolved.model
  recordThreadModel(threadId, model)
  // The model actually running this turn — stamped on Cursor hook agent-session
  // payloads (B4). Set before any hook can fire (beforeSubmitPrompt below, the
  // tool gate, afterFileEdit, stop) so every one reports the real model.
  setActiveRunModel(model)
  const remoteSelection = parseRemoteAgentModelSelection(model)
  const acpSelection = parseAcpModelSelection(model)
  const acpAgentId = acpSelection?.id ?? null

  const sendChunk = createAgentChunkSink(threadId, host)

  // The turn-tree epoch this run belongs to (decision 16 / C3): the renderer
  // mints it for a human submission / release and threads it on the payload, so
  // the continuation ledger and the `stop` hook's epoch line up with the
  // renderer's drain-time budget check. Falls back to the thread id when absent
  // (older client / ACP / standalone retry).
  const turnTreeId: TurnTreeId = asTurnTreeId(
    options?.turnTreeId && options.turnTreeId.length > 0 ? options.turnTreeId : threadId,
  )

  // B1: fire `beforeSubmitPrompt` on the compose path, before any agent turn
  // starts (ACP / remote / local). A blocking decision hook may halt the submit
  // (`continue: false`); when it does we surface its user-facing message through
  // the existing text/`done` channel and return without starting the turn — the
  // blocked prompt never enters LLM history. Spine recording is attributed the
  // same way the turn's own hooks are (decision 6, always-on).
  const blocked = await runBeforeSubmitPrompt(threadId, userPrompt)
  if (blocked) {
    sendChunk({ type: 'text', text: blocked })
    sendChunk({ type: 'done' })
    return { usage: { inputTokens: 0, outputTokens: 0 }, messages: priorMessages }
  }

  // Experimental PII redaction: when enabled, swap personal data the user typed
  // for stable placeholders before the prompt leaves the device — for every
  // provider path (local, remote, ACP). The redacted form is also what we persist
  // to thread history, so placeholders stay consistent across turns. No-op when
  // the feature is off or Rampart is unavailable.
  const outboundPrompt = await redactUserContent(threadId, userPrompt)

  if (resolved.fallbackNotice) {
    sendChunk({ type: 'text', text: resolved.fallbackNotice })
  }

  if (acpAgentId) {
    const controller = new AbortController()
    abortMap.set(threadId, controller)
    setActiveRunThread(threadId)
    const runAbort = createAgentRunAbortScheduler(controller)
    runAbort.schedule()
    // The advisor works both ways for ACP: an external executor can consult it
    // through the native-tool bridge. Unlike the native loop (context set around
    // each call), bridged calls arrive over HTTP at any point in the turn, so
    // the context is scoped to the whole ACP run. The transcript is Copse's
    // view: prior thread history, this turn's user prompt, and whatever the
    // agent has streamed so far.
    let acpAssistantText = ''
    const acpChunkSink = (chunk: StreamChunk): void => {
      if (chunk.type === 'text') acpAssistantText += chunk.text
      sendChunk(chunk)
    }
    const advisorContext = registry.has('advisor')
      ? {
          advisorModel: resolveAdvisorModelId(),
          executorModel: model,
          getTranscript: (): LLMMessage[] => [
            ...priorMessages,
            { role: 'user' as const, content: outboundPrompt },
            ...(acpAssistantText.trim()
              ? [{ role: 'assistant' as const, content: acpAssistantText }]
              : []),
          ],
        }
      : null
    try {
      const result = await runAcpAgentFromSettings({
        threadId,
        agentId: acpAgentId,
        userPrompt: outboundPrompt,
        priorMessages,
        signal: controller.signal,
        onChunk: acpChunkSink,
        registry,
        ...(advisorContext ? { advisorContext } : {}),
        ...(options?.invokedSkills?.length ? { invokedSkills: options.invokedSkills } : {}),
        ...(acpSelection?.model ? { model: acpSelection.model } : {}),
      })
      sendChunk({ type: 'done', stopReason: result.stopReason })
      return {
        usage: result.usage,
        messages: [
          ...priorMessages,
          { role: 'user' as const, content: outboundPrompt },
          ...result.messages,
        ],
      }
    } catch (err) {
      // Keep what the failed turn streamed: the partial assistant text stays in
      // history (so the next turn's preamble knows what already happened) and
      // its estimated usage is reported instead of a silent zero. The error
      // text is separated from any streamed text so the bubble stays readable.
      const partial = err instanceof AcpTurnFailure ? err.partial : null
      const msg = classifyAgentError(err, { acpAgentId })
      sendChunk({ type: 'text', text: partial?.assistantText ? `\n\n${msg}` : msg })
      sendChunk({ type: 'done' })
      return {
        usage: partial?.usage ?? { inputTokens: 0, outputTokens: 0 },
        messages: [
          ...priorMessages,
          { role: 'user' as const, content: outboundPrompt },
          ...(partial?.assistantText
            ? [
                {
                  role: 'assistant' as const,
                  content: `${partial.assistantText}\n\n[This turn was interrupted by a transient provider error before it completed.]`,
                },
              ]
            : []),
        ],
      }
    } finally {
      // B3: agent work has stopped (turn end or abort) — fire `stop` detached.
      fireStopHook(threadId, controller.signal.aborted ? 'aborted' : 'completed', turnTreeId)
      runAbort.clear()
      clearActiveRunThread(threadId)
      abortMap.delete(threadId)
    }
  }

  if (remoteSelection) {
    const controller = new AbortController()
    abortMap.set(threadId, controller)
    setActiveRunThread(threadId)
    const runAbort = createAgentRunAbortScheduler(controller)
    runAbort.schedule()
    try {
      const result = await runRemoteAgentFromSettings({
        threadId,
        provider: remoteSelection.provider,
        ...(remoteSelection.model ? { model: remoteSelection.model } : {}),
        userPrompt: outboundPrompt,
        priorMessages,
        signal: controller.signal,
        onChunk: sendChunk,
      })
      return {
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        messages: [
          ...priorMessages,
          { role: 'user' as const, content: outboundPrompt },
          ...result.messages,
        ],
      }
    } catch (err) {
      const msg = classifyAgentError(err)
      sendChunk({ type: 'text', text: msg })
      sendChunk({ type: 'done' })
      return {
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [...priorMessages, { role: 'user' as const, content: outboundPrompt }],
      }
    } finally {
      // B3: agent work has stopped (turn end or abort) — fire `stop` detached.
      fireStopHook(threadId, controller.signal.aborted ? 'aborted' : 'completed', turnTreeId)
      runAbort.clear()
      clearActiveRunThread(threadId)
      abortMap.delete(threadId)
    }
  }

  let trimmed: LLMMessage[] = [...priorMessages, { role: 'user', content: outboundPrompt }]
  let inputTokens = 0
  let outputTokens = 0

  const controller = new AbortController()
  abortMap.set(threadId, controller)
  setActiveRunThread(threadId)
  // Attribute hook executions (function + command) to this run's spine records
  // (decision 6 — always-on).
  beginHookRunRecording(threadId)
  const runAbort = createAgentRunAbortScheduler(controller)
  runAbort.schedule()

  // Seed the shared continuation budget for this turn tree (decision 5) with the
  // machine turns already spent on the renderer's queue-drain continuations, so
  // the in-run tighteners below (todo closeout, the pre-review gate, remediation
  // cycles) share one counter per turn tree and can only tighten inside the
  // shared cap. `forget` in the finally keeps the map from growing across runs —
  // the renderer re-seeds the spent count on the next run of the same turn tree.
  const budgetLedger = getContinuationLedger()
  budgetLedger.seed(turnTreeId, options?.continuationBudgetUsed ?? 0)
  const continuationBudget: ContinuationGrant = {
    tryGrant: () => budgetLedger.tryGrant(turnTreeId),
    remaining: () => budgetLedger.remaining(turnTreeId),
  }

  try {
    const invokedSkills = options?.invokedSkills ?? []
    const subagentsEnabled = getSetting<boolean>(
      SUBAGENTS_ENABLED_SETTING,
      SUBAGENTS_ENABLED_DEFAULT,
    )
    const contextWindow = await resolveContextWindow(model)
    const toolSchemaReserve = toolSchemaReserveForModel(model)
    const provider = await buildProvider(model, threadId)
    const subagentRoute = subagentsEnabled ? await buildSubagentRoute(model) : null
    const subagentUsageModel = subagentRoute?.usageModel ?? model
    // Local routing was asked for (cloud parent + setting on) but no local
    // route resolved (LM Studio down / no model): the fallback to the cloud
    // parent model is silent, so stamp it on subagent cards (issue feedback).
    const subagentLocalFallback =
      subagentsEnabled &&
      !subagentRoute &&
      !isLocalChatModel(model) &&
      getSetting<boolean>('localSubagentsEnabled', true)

    // Set when the turn runs any file-mutating tool, gating the post-turn review.
    let turnChangedFiles = false
    // Set when the agent already ran a comparison via the `compare_models` tool
    // this turn, so the auto-on-review trigger doesn't run a second (billable) one.
    let comparisonRanThisTurn = false
    // The agent loop's terminal `done` chunk is held back until the post-turn
    // review finishes, so the thread doesn't flip to idle (and drain its queued
    // messages) while the review is still running.
    let deferredDone: Extract<StreamChunk, { type: 'done' }> | null = null

    const systemPrompt = await buildSystemPrompt({ subagentsEnabled, invokedSkills })

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      { role: 'user', content: outboundPrompt },
    ]

    // Use the redacted prompt: parentGoal is embedded in subagent prompts and the
    // working brief, both of which reach providers.
    const parentGoal = resolveParentGoal(options?.workingBrief, messages, outboundPrompt)

    // Steering checks are local-only (they decide which prompt blocks to add), so
    // they run on the raw text — redaction must not change which steering fires.
    // M0.2: policy lives in named `turnStart` hooks; this site only fires the
    // event and applies the merged `injectContext` to messages[0].
    const userTextForSteering =
      typeof userPrompt === 'string'
        ? userPrompt
        : resolveParentGoal(undefined, messages, userPrompt)
    const priorTodos = options?.priorTodos ?? []

    // Fingerprint the toolset offered to the model before any hook can fire, so
    // every hook_run spine record — including turnStart's — references it
    // (decision 6). The tool list is fixed for the whole run.
    const readonlyMode = getSetting<boolean>('defaultReadonlyMode', false)
    const parentLoopTools = parentTools(registry, subagentsEnabled, readonlyMode, model)
    setHookRunToolset(parentLoopTools)

    const turnStart = await createHookRegistry().emit(
      'turnStart',
      { userText: userTextForSteering, priorTodos },
      {
        signal: controller.signal,
        resolveGithubRepoSlug: () => getGithubRepoSlug(),
        recordHookRun: recordFunctionHookRun,
      },
    )
    const injected = mergeBlockingOutcomes(turnStart.outcomes).injectContext
    if (injected && messages[0]?.role === 'system') {
      messages[0] = {
        role: 'system',
        content: messages[0].content + `\n\n${injected}`,
      }
    }

    const prepared = prepareAgentHistory(messages, contextWindow, toolSchemaReserve)
    trimmed = prepared.trimmed
    const { wasTrimmed, conversationBudget } = prepared
    const { notifyTrimmed } = createTrimNotifier(wasTrimmed)
    const sendTrimNotice = (): void => {
      sendChunk(contextTrimmedChunk(trimmed, contextWindow, prepared.historyBudget))
    }
    if (wasTrimmed) notifyTrimmed(sendTrimNotice)

    sendChunk(contextPressureChunk(prepared, contextWindow))

    // A single turn that overflows the context even after trimming can never
    // succeed: the trimmer cannot drop the user's own message, so sending it
    // only earns a provider "context length" rejection and, on metered
    // providers, burns input-token rate-limit budget on a doomed request.
    // Fail fast with actionable guidance instead.
    if (promptExceedsContextWindow(prepared, contextWindow)) {
      sendChunk({
        type: 'text',
        text: oversizedTurnMessage(contextWindow, prepared.estimatedPromptTokens),
      })
      sendChunk({ type: 'done' })
      return {
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: trimmed.filter((m) => m.role !== 'system'),
      }
    }

    const runReadLimits = readFileLimitsFromConversationBudget(conversationBudget)

    resetSubagentUsage()

    setAgentRunTodoContext({
      initial: priorTodos,
      onUpdate: (todos) => {
        sendChunk({ type: 'todo_update', todos })
      },
    })

    setTodoToolPostProcess(async (before, after) => {
      let todos = after
      let extraMessage: string | undefined

      const localItem = findNewlyInProgressLocal(before, after)
      if (
        localItem &&
        shouldRouteToLocal(localItem, {
          localTodoItemsEnabled: getSetting<boolean>('localTodoItemsEnabled', true),
          parentIsLocal: isLocalChatModel(model),
        }) &&
        subagentRoute
      ) {
        sendChunk({ type: 'todo_worker_start', todoId: localItem.id, content: localItem.content })
        try {
          const worker = await runTodoWorker({
            item: localItem,
            provider: subagentRoute.provider,
            registry,
            contextWindow: subagentRoute.contextWindow,
            toolSchemaReserve: subagentRoute.toolSchemaReserve,
            signal: controller.signal,
            onChunk: sendChunk,
          })
          inputTokens += worker.usage.inputTokens
          outputTokens += worker.usage.outputTokens
          sendChunk({
            type: 'usage',
            model: subagentUsageModel,
            inputTokens: worker.usage.inputTokens,
            outputTokens: worker.usage.outputTokens,
          })

          let passed = true
          if (localItem.check) {
            const check = await verifyTodoCheck(localItem.check, controller.signal)
            passed = check.passed
            extraMessage = passed
              ? `Local worker completed "${localItem.content}" (${check.detail})`
              : `Local worker finished but check failed: ${check.detail}`
          }

          todos = todos.map((t) =>
            t.id === localItem.id ? { ...t, status: passed ? 'completed' : 'in_progress' } : t,
          )
          sendChunk({ type: 'todo_update', todos })
          sendChunk({
            type: 'todo_worker_done',
            todoId: localItem.id,
            summary: worker.summary,
            passed,
          })
        } catch (err) {
          const msg = errorMessage(err)
          extraMessage = `Local worker failed: ${msg}`
          sendChunk({
            type: 'todo_worker_done',
            todoId: localItem.id,
            summary: msg,
            passed: false,
          })
        }
      }

      const completed = findNewlyCompleted(before, todos)
      if (completed && compactAtTodoBoundary(trimmed, todos)) {
        notifyTrimmed(sendTrimNotice)
      }

      return { todos, ...(extraMessage ? { extraMessage } : {}) }
    })

    // The parent tool executor, shared by the main loop and any post-turn parent
    // continuation turns (pre-review todo gate, review remediation) so both route
    // subagents, advisor, comparison, and shell tagging identically.
    const runParentTool = async (
      name: string,
      args: unknown,
      signal: AbortSignal,
      toolCallId: string,
    ): Promise<ToolExecuteResult> => {
      if (isEditTool(name)) turnChangedFiles = true
      if (name === 'explore' && subagentsEnabled) {
        // ALS-scoped (not a global slot): the loop runs fanned-out
        // explore calls concurrently, each with its own context.
        return runWithExploreSubagentContext(
          {
            parentToolCallId: toolCallId,
            parentGoal,
            provider: subagentRoute?.provider ?? provider,
            registry,
            contextWindow: subagentRoute?.contextWindow ?? contextWindow,
            toolSchemaReserve: subagentRoute?.toolSchemaReserve ?? toolSchemaReserve,
            onChunk: sendChunk,
            usageModel: subagentUsageModel,
            localFallback: subagentLocalFallback,
          },
          () => registry.execute(name, args, signal),
        )
      }
      if (name === 'investigate_ci' && subagentsEnabled) {
        setCiInvestigatorContext({
          parentToolCallId: toolCallId,
          parentGoal,
          provider: subagentRoute?.provider ?? provider,
          registry,
          contextWindow: subagentRoute?.contextWindow ?? contextWindow,
          toolSchemaReserve: subagentRoute?.toolSchemaReserve ?? toolSchemaReserve,
          onChunk: sendChunk,
          usageModel: subagentUsageModel,
          localFallback: subagentLocalFallback,
        })
        try {
          return await registry.execute(name, args, signal)
        } finally {
          setCiInvestigatorContext(null)
        }
      }
      if (name === 'advisor') {
        // Client-side advisor: hand the tool the live transcript so it can
        // forward it to a larger advisor model (issue #566). Mirrors the
        // native tool's automatic transcript forwarding.
        return runWithAdvisorContext(
          {
            advisorModel: resolveAdvisorModelId(),
            executorModel: model,
            getTranscript: () => trimmed,
          },
          () => registry.executeNormalized(name, args, signal),
        )
      }
      if (name === 'delegate_step') {
        // Orchestration strategy: the parent stays the orchestrator while a
        // cheaper worker model implements this one step as a subagent; the
        // tool result carries the worker's report + working-tree snapshot so
        // the parent observes between steps. ALS-scoped like explore so
        // fanned-out independent steps each keep their own context. A
        // delegated step is file-mutating by design, so it gates the
        // post-turn review like a direct edit would.
        turnChangedFiles = true
        return runWithOrchestrationContext(
          {
            parentToolCallId: toolCallId,
            parentGoal,
            workerModel: resolveOrchestrationWorkerModelId(),
            registry,
            onChunk: sendChunk,
          },
          () => registry.execute(name, args, signal),
        )
      }
      if (name === 'compare_models') {
        // Manual trigger: run the two-model diff comparison on demand, with
        // the live parent goal/registry so the reviewers see the same diff.
        comparisonRanThisTurn = true
        setModelComparisonContext({
          threadId,
          parentGoal,
          registry,
          chatModel: model,
          onChunk: sendChunk,
        })
        try {
          return await registry.executeNormalized(name, args, signal)
        } finally {
          setModelComparisonContext(null)
        }
      }
      if (name === 'run_shell') {
        // Tag the command's streamed output with this tool-call id so the
        // terminal pane can route it into the matching "Agent tasks" card.
        setCurrentShellTaskId(toolCallId)
        try {
          return await registry.executeNormalized(name, args, signal)
        } finally {
          setCurrentShellTaskId(null)
        }
      }
      return registry.executeNormalized(name, args, signal)
    }

    // D2: fire the canonical `afterToolUse` observation after each tool result
    // (shell / MCP flavors), detached — never blocking the loop. Wrapping the
    // shared executor is the single tool-result choke point that covers the main
    // loop and every post-turn continuation turn. The output snapshot is capped
    // downstream (`runAfterToolUseHooks`) before it reaches a hook's stdin.
    const executeParentTool = async (
      name: string,
      args: unknown,
      signal: AbortSignal,
      toolCallId: string,
    ): Promise<ToolExecuteResult> => {
      const startedAt = Date.now()
      try {
        const raw = await runParentTool(name, args, signal, toolCallId)
        fireAfterToolUseHook({
          threadId,
          turnTreeId,
          toolName: name,
          toolCallId,
          isError: false,
          input: args,
          output: normalizeToolExecuteResult(raw).result,
          durationMs: Date.now() - startedAt,
        })
        return raw
      } catch (err) {
        // The loop turns a thrown tool into an error tool-result; mirror that so
        // the observation sees the same `isError: true` + message the model does.
        fireAfterToolUseHook({
          threadId,
          turnTreeId,
          toolName: name,
          toolCallId,
          isError: true,
          input: args,
          output: `Error: ${errorMessage(err)}`,
          durationMs: Date.now() - startedAt,
        })
        throw err
      }
    }

    await runWithAgentRunReadonly(readonlyMode, async () => {
      await runWithAgentRunReadFileLimits(runReadLimits, async () => {
        await runAgentLoop({
          provider,
          messages: trimmed,
          tools: parentLoopTools,
          usageModel: model,
          maxLlmCalls: DEFAULT_MAX_LLM_CALLS,
          runDeadline: runAbort.deadline,
          onRunDeadlineActivity: runAbort.schedule,
          coerceTextToolCallArgs: (name, args) => registry.tryCoerceArgs(name, args),
          getOpenTodos: () => getAgentRunTodos(),
          continuationBudget,
          recordHookRun: recordFunctionHookRun,
          onLlmCall: setHookRunStep,
          executeTool: executeParentTool,
          signal: controller.signal,
          maxContextTokens: contextWindow,
          toolSchemaReserveTokens: toolSchemaReserve,
          onHistoryTrimmed: () => {
            notifyTrimmed(sendTrimNotice)
          },
          getLastUsage: () => (hasLastUsage(provider) ? provider.lastUsage : null),
          onChunk: (chunk) => {
            if (chunk.type === 'done') {
              deferredDone = chunk
              return
            }
            sendChunk(chunk)
            if (chunk.type === 'usage') {
              inputTokens += chunk.inputTokens
              outputTokens += chunk.outputTokens
            }
          },
        })

        const subUsage = getAccumulatedSubagentUsage()
        if (subUsage.inputTokens || subUsage.outputTokens) {
          inputTokens += subUsage.inputTokens
          outputTokens += subUsage.outputTokens
          sendChunk({
            type: 'usage',
            model: subagentUsageModel,
            inputTokens: subUsage.inputTokens,
            outputTokens: subUsage.outputTokens,
            ...(subUsage.cacheReadTokens !== undefined
              ? { cacheReadTokens: subUsage.cacheReadTokens }
              : {}),
            ...(subUsage.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: subUsage.cacheCreationTokens }
              : {}),
          })
        }
      })
    })

    const parentContinuationBase: RunParentContinuationOptions = {
      provider,
      messages: trimmed,
      tools: parentLoopTools,
      contextWindow,
      toolSchemaReserve,
      signal: controller.signal,
      usageModel: model,
      executeTool: executeParentTool,
      onChunk: (chunk: StreamChunk): void => {
        if (chunk.type === 'done') return
        sendChunk(chunk)
        if (chunk.type === 'usage') {
          inputTokens += chunk.inputTokens
          outputTokens += chunk.outputTokens
        }
      },
      getOpenTodos: (): TodoItem[] => getAgentRunTodos(),
      setTodos: (todos: TodoItem[]): void => {
        setAgentRunTodos(todos)
      },
      onHistoryTrimmed: (): void => {
        notifyTrimmed(sendTrimNotice)
      },
      getLastUsage: (): { inputTokens: number; outputTokens: number } | null =>
        hasLastUsage(provider) ? provider.lastUsage : null,
      coerceTextToolCallArgs: (name: string, args: unknown) => registry.tryCoerceArgs(name, args),
      onEditTool: (name: string): void => {
        if (isEditTool(name)) turnChangedFiles = true
      },
      recordHookRun: recordFunctionHookRun,
      onLlmCall: setHookRunStep,
      continuationBudget,
      userNudge: '',
      maxSteps: 6,
    }

    // Pre-review gate: if the plan still has open todos, give the parent a couple
    // of deterministic continuation turns to reconcile them before review runs.
    if (getAgentRunTodos().length > 0 && hasOpenTodos(getAgentRunTodos())) {
      await runWithAgentRunReadFileLimits(runReadLimits, async () => {
        await runPreReviewTodoGate(parentContinuationBase)
      })
    }

    // Post-turn review: read-only review over the working diff, with an optional
    // bounded parent remediation loop when the reviewer requests follow-up. Runs
    // before the deferred `done` so the thread stays "running" until it lands.
    //
    // Cost gates (#584): (a) skip when the working diff is empty / below
    // `postTurnReviewMinChangedLines` — there's nothing worth a review LLM run; and
    // (b) when the review would use a billable model, ask once per chat for spend
    // approval (remembered) so paid reviews on every file-mutating turn are opt-in.
    // A free / local review model runs on the full diff with no prompt.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated inside the runAgentLoop callback above; TS narrows to the `false` initializer
    if (turnChangedFiles && getSetting<boolean>('postTurnReviewEnabled', true)) {
      const reviewRoute = await buildReviewRoute()
      const reviewProvider = reviewRoute?.provider ?? provider
      const reviewUsageModel = reviewRoute?.usageModel ?? model
      const reviewContextWindow = reviewRoute?.contextWindow ?? contextWindow
      const reviewToolSchemaReserve = reviewRoute?.toolSchemaReserve ?? toolSchemaReserve

      const minChangedLines = getSetting<number>('postTurnReviewMinChangedLines', 1)
      const nothingToReview = minChangedLines > 0 && (await changedLinesBelow(minChangedLines))
      const reviewApproved =
        nothingToReview ||
        !isBillableModel(reviewUsageModel) ||
        (await ensureReviewApproved(reviewUsageModel, threadId, controller.signal))

      if (nothingToReview) {
        sendChunk({
          type: 'post_turn_review',
          status: 'skipped',
          summary: 'Nothing to review in the working diff.',
        })
      } else if (!reviewApproved) {
        sendChunk({
          type: 'post_turn_review',
          status: 'skipped',
          summary: controller.signal.aborted
            ? 'Review cancelled.'
            : `Review skipped — spending on ${reviewUsageModel} was not approved.`,
        })
      } else {
        for (let cycle = 0; cycle < MAX_POST_TURN_REVIEW_CYCLES; cycle++) {
          sendChunk({ type: 'post_turn_review', status: 'running', summary: '' })
          try {
            const review = await runPostTurnReviewOnce({
              parentGoal,
              todos: getAgentRunTodos(),
              provider: reviewProvider,
              registry,
              contextWindow: reviewContextWindow,
              toolSchemaReserve: reviewToolSchemaReserve,
              signal: controller.signal,
              usageModel: reviewUsageModel,
              onUsage: (u) => {
                inputTokens += u.inputTokens
                outputTokens += u.outputTokens
                sendChunk({
                  type: 'usage',
                  model: reviewUsageModel,
                  inputTokens: u.inputTokens,
                  outputTokens: u.outputTokens,
                })
              },
            })

            const todosAfterReview = applyReviewTodoUpdates(getAgentRunTodos(), review.verdict)
            if (todosAfterReview.length > 0 || getAgentRunTodos().length > 0) {
              setAgentRunTodos(todosAfterReview)
            }

            sendChunk({
              type: 'post_turn_review',
              status: 'done',
              summary: review.summary,
              issuesFound: review.verdict.issuesFound,
            })

            const lastCycle = cycle >= MAX_POST_TURN_REVIEW_CYCLES - 1
            if (!review.verdict.requestFollowUp || lastCycle || controller.signal.aborted) {
              break
            }

            // A remediation cycle is a machine-initiated new turn (decision 5):
            // consume one grant from the shared budget before running it. The
            // local cap (MAX_POST_TURN_REVIEW_CYCLES) tightens inside the shared
            // cap — once the budget is exhausted, no further remediation runs.
            if (!continuationBudget.tryGrant()) break

            const remediation = { madeEdits: false }
            await runWithAgentRunReadFileLimits(runReadLimits, async () => {
              await runParentContinuationTurn({
                ...parentContinuationBase,
                userNudge: buildReviewRemediationNudge(review.verdict),
                maxSteps: 8,
                onEditTool: (name: string): void => {
                  if (isEditTool(name)) {
                    turnChangedFiles = true
                    remediation.madeEdits = true
                  }
                },
              })
            })
            if (!remediation.madeEdits) break
          } catch (err) {
            const detail = controller.signal.aborted ? 'Review cancelled.' : classifyAgentError(err)
            sendChunk({ type: 'post_turn_review', status: 'error', summary: detail })
            break
          }
        }
      }
    }

    // Auto model comparison: when this turn changed files and the harness is set
    // to run on review, compare two models on the working diff (gated by a spend
    // approval for billable models). Usage is folded in via the emitted chunks.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated inside the runAgentLoop callback above; TS narrows to the `false` initializer
    if (turnChangedFiles && !comparisonRanThisTurn && isAutoComparisonEnabled()) {
      await runModelComparison(
        { threadId, parentGoal, registry, chatModel: model, onChunk: sendChunk },
        controller.signal,
      )
    }

    // C3 run→drain fold-back (decision 5): report the machine turns this run
    // spent in-process (closeout / pre-review / remediation grants) back to the
    // renderer *before* the terminal `done` triggers its next queue drain, so
    // the drain-time budget check sees the full turn-tree spend. Epoch-guarded
    // + monotonic on the renderer side (decision 16).
    sendChunk({ type: 'continuation_budget', used: budgetLedger.used(turnTreeId), turnTreeId })
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned inside the onChunk callback above; TS narrows to the `null` initializer
    sendChunk(deferredDone ?? { type: 'done' })
  } catch (err) {
    const msg = classifyAgentError(err)
    sendChunk({ type: 'text', text: msg })
    // Fold back any in-run spend even on the error path — grants consumed before
    // the failure still count against the turn tree (decision 5).
    sendChunk({ type: 'continuation_budget', used: budgetLedger.used(turnTreeId), turnTreeId })
    sendChunk({ type: 'done' })
  } finally {
    // B3: agent work has stopped (turn end, error, or abort) — fire `stop`
    // detached (decision 3). Fired before `endHookRunRecording` so the dispatch
    // begins while this run's recording session is still open; being detached it
    // is never awaited, so it cannot delay the turn's `done` above.
    fireStopHook(threadId, controller.signal.aborted ? 'aborted' : 'completed', turnTreeId)
    // Drop this run's ledger entry (decision 5): the renderer stays authoritative
    // across the turn tree and re-seeds the spent count on the next run, so the
    // per-run seed here need not persist — this keeps the ledger map bounded.
    budgetLedger.forget(turnTreeId)
    runAbort.clear()
    clearAgentRunTodos()
    setTodoToolPostProcess(null)
    endHookRunRecording(threadId)
    clearActiveRunThread(threadId)
    abortMap.delete(threadId)
  }

  const updatedHistory = trimmed.filter((m) => m.role !== 'system')
  return { usage: { inputTokens, outputTokens }, messages: updatedHistory }
}

export function abortAgent(threadId: string): void {
  abortMap.get(threadId)?.abort()
}

export interface RetryOptions {
  workingBrief?: string
  model?: string
}

/** Register a fresh abort controller for a standalone review/comparison retry,
 *  mirroring the turn path so the Stop button (agent:abort) can cancel it. */
function beginRetryRun(threadId: string): {
  controller: AbortController
  runAbort: ReturnType<typeof createAgentRunAbortScheduler>
} {
  const controller = new AbortController()
  abortMap.set(threadId, controller)
  setActiveRunThread(threadId)
  const runAbort = createAgentRunAbortScheduler(controller)
  runAbort.schedule()
  return { controller, runAbort }
}

/**
 * Re-run the post-turn review for a thread on demand — the retry action on a
 * failed review card. The review reads the current working diff, so a failure
 * the user can fix in place (e.g. the local model server had a different model
 * loaded, or a transient provider error) is recoverable without re-running the
 * whole turn. Rebuilds the model context from the thread's current model and
 * emits the same `post_turn_review` chunks as the auto path, then a `done` so
 * the thread returns to idle.
 */
export async function retryPostTurnReview(
  threadId: string,
  priorMessages: LLMMessage[],
  host: AgentHost<StreamChunk>,
  registry: ToolRegistry,
  options?: RetryOptions,
): Promise<void> {
  const requestedModel = options?.model ?? getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const model = (await resolveAgentChatModel(requestedModel)).model
  const sendChunk = createAgentChunkSink(threadId, host)
  const { controller, runAbort } = beginRetryRun(threadId)

  sendChunk({ type: 'post_turn_review', status: 'running', summary: '' })
  try {
    const contextWindow = await resolveContextWindow(model)
    const toolSchemaReserve = toolSchemaReserveForModel(model)
    const provider = await buildProvider(model, threadId)
    const parentGoal = resolveParentGoal(options?.workingBrief, priorMessages, '')
    const reviewRoute = await buildReviewRoute()
    const reviewUsageModel = reviewRoute?.usageModel ?? model
    const review = await runPostTurnReview({
      parentGoal,
      provider: reviewRoute?.provider ?? provider,
      registry,
      contextWindow: reviewRoute?.contextWindow ?? contextWindow,
      toolSchemaReserve: reviewRoute?.toolSchemaReserve ?? toolSchemaReserve,
      signal: controller.signal,
      usageModel: reviewUsageModel,
      onUsage: (u) => {
        sendChunk({
          type: 'usage',
          model: reviewUsageModel,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
        })
      },
    })
    sendChunk({
      type: 'post_turn_review',
      status: 'done',
      summary: review.summary,
      issuesFound: review.issuesFound,
    })
  } catch (err) {
    const detail = controller.signal.aborted ? 'Review cancelled.' : classifyAgentError(err)
    sendChunk({ type: 'post_turn_review', status: 'error', summary: detail })
  } finally {
    runAbort.clear()
    clearActiveRunThread(threadId)
    abortMap.delete(threadId)
    sendChunk({ type: 'done' })
  }
}

/**
 * Re-run the two-model comparison for a thread on demand — the retry action on a
 * failed comparison card. Like {@link retryPostTurnReview}, it reviews the
 * current working diff, so a fixable failure (a mis-loaded local model, a
 * declined/aborted run) can be retried in place. `runModelComparison` emits its
 * own running/terminal `model_comparison` chunks (and re-asks for spend approval
 * when a model is billable); we bracket it with a `done` so the thread idles.
 */
export async function retryModelComparison(
  threadId: string,
  priorMessages: LLMMessage[],
  host: AgentHost<StreamChunk>,
  registry: ToolRegistry,
  options?: RetryOptions,
): Promise<void> {
  const requestedModel = options?.model ?? getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const model = (await resolveAgentChatModel(requestedModel)).model
  const sendChunk = createAgentChunkSink(threadId, host)
  const { controller, runAbort } = beginRetryRun(threadId)

  try {
    const parentGoal = resolveParentGoal(options?.workingBrief, priorMessages, '')
    await runModelComparison(
      { threadId, parentGoal, registry, chatModel: model, onChunk: sendChunk },
      controller.signal,
    )
  } finally {
    runAbort.clear()
    clearActiveRunThread(threadId)
    abortMap.delete(threadId)
    sendChunk({ type: 'done' })
  }
}
