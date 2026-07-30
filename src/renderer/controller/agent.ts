import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  appendToken,
  appendReasoning,
  addToolCall,
  updateToolCall,
  findToolCall,
  setMessageContent,
  setMessageCommandSummary,
  setMessageToolSummary,
  setThreadStatus,
  addUsageDelta,
  recordContextTrim,
  updateContextSnapshot,
  setThreadTodos,
  setMessageReview,
  setThreadComparison,
  addHookCard,
  getThreadById,
} from '@shared/store/thread-helpers.ts'
import { syncThreadGitBranchAfterShell } from './sync-thread-branch-after-shell.ts'
import { shellCommandMayChangeBranch } from '@shared/git/sync-thread-branch.ts'
import { getToolCallLabel, shellCommandsFromToolCalls } from '@shared/tools/tool-display.ts'
import {
  initSubagent,
  appendSubagentText,
  addSubagentToolCall,
  updateSubagentToolCall,
  finishSubagent,
} from '@shared/store/subagent-helpers.ts'
import { planAgentTextChunk } from '@copse/agent/agent-text-chunk.ts'
import { syncAgentActivity, CONTEXT_TRIM_ACTIVITY } from '../agent-activity.ts'
import { drainMessageQueue, enqueueHookMessage, foldBackContinuationUsed } from './message-queue.ts'
import { maybeNameThread } from './thread-naming.ts'
import { usageRecordFromAgentDelta } from '@shared/usage/usage-record-input.ts'
import type { UsageDelta } from '@shared/types'

/** Stamp the thread's picker model onto a new primary-chat assistant bubble. */
function addAssistantMessage(store: AppStore, threadId: string): string {
  const model = getThreadById(store, threadId)?.model ?? store.getState().settings?.model
  return addMessage(
    store,
    threadId,
    'assistant',
    '',
    undefined,
    undefined,
    model !== undefined ? { model } : undefined,
  )
}

function recordUsageToLedger(
  api: ApiClient,
  store: AppStore,
  threadId: string,
  delta: UsageDelta,
): void {
  if (!delta.inputTokens && !delta.outputTokens) return
  const { activeProjectId } = store.getState()
  void api.usage
    .record(usageRecordFromAgentDelta(threadId, delta, activeProjectId))
    .catch((err: unknown) => {
      console.error('[usage] failed to record usage event:', err)
    })
}

export function startAgentController(store: AppStore, api: ApiClient): () => void {
  // Per-thread streaming state: the message currently accumulating text, and
  // whether a tool call has arrived since the last text chunk. When text
  // resumes after tool calls, we finalize the current message and start a new
  // one so the final answer renders BELOW the tool cards rather than above them.
  type ThreadStreamState = {
    msgId: string | null
    toolSinceText: boolean
    // Accumulated visible text of the current assistant message, threaded into
    // planAgentTextChunk so a tool call that interrupts mid-sentence keeps the
    // resumed text in the same bubble.
    currentText: string
    writing: boolean
    // Which message we've already requested a command summary for, and at what
    // shell-command count, so we re-summarize only when more commands arrive.
    summaryMsgId: string | null
    summaryCount: number
    // Same guard for the whole-turn tool rollup polish (`toolSummary`).
    toolSummaryMsgId: string | null
    toolSummaryCount: number
  }
  const state = new Map<string, ThreadStreamState>()
  const get = (tid: string): ThreadStreamState => {
    let st = state.get(tid)
    if (!st) {
      st = {
        msgId: null,
        toolSinceText: false,
        currentText: '',
        writing: false,
        summaryMsgId: null,
        summaryCount: 0,
        toolSummaryMsgId: null,
        toolSummaryCount: 0,
      }
      state.set(tid, st)
    }
    return st
  }
  const activity = (tid: string): void => {
    syncAgentActivity(store, tid, get(tid).writing)
  }

  type QueuedDiffSummary = { path: string; language: string }
  const diffQueuesByOwner = new Map<string, QueuedDiffSummary[]>()
  const ownerKey = (projectId: string, threadId: string): string =>
    JSON.stringify([projectId, threadId])
  const isActiveOwner = (projectId: string, threadId: string): boolean => {
    const current = store.getState()
    return current.activeProjectId === projectId && current.activeThreadId === threadId
  }
  const publishActiveQueue = (entries: QueuedDiffSummary[]): void => {
    const { activeDiff } = store.getState()
    const stillQueued =
      activeDiff && entries.some((entry) => entry.path === activeDiff.path) ? activeDiff : null
    store.setState({
      stagedDiffs: entries,
      rightPanelMode: entries.length > 0 ? 'changes' : store.getState().rightPanelMode,
      filesPaneOpen: entries.length > 0 ? true : store.getState().filesPaneOpen,
      activeDiff: entries.length === 0 ? null : stillQueued,
    })
    store.emit('staged_diffs_changed')
    store.emit('panel_changed')
    if (entries.length > 0) store.emit('right_panel_mode_changed')
    store.emit('files_pane_changed')
  }

  const unsub = api.agent.onChunk((threadId, chunk) => {
    const st = get(threadId)
    switch (chunk.type) {
      case 'text': {
        const { plan, state: nextState } = planAgentTextChunk(
          { msgId: st.msgId, toolSinceText: st.toolSinceText, currentText: st.currentText },
          chunk.text,
        )
        if (plan.action === 'ignore') break

        if (plan.startNewMessage) {
          if (plan.finalizeMsgId) store.emit('message_done', plan.finalizeMsgId)
          st.msgId = addAssistantMessage(store, threadId)
        }
        st.toolSinceText = nextState.toolSinceText
        st.currentText = nextState.currentText ?? ''
        if (st.msgId === null) throw new Error('assistant message id missing for text chunk')
        appendToken(store, st.msgId, plan.text)

        if (plan.text.trim()) {
          st.writing = true
          activity(threadId)
          // First visible assistant output — start naming without waiting for `done`.
          maybeNameThread(store, api, threadId)
        }
        break
      }
      case 'reasoning': {
        // Reasoning precedes this step's answer. If the previous step ended with
        // tool calls, start a fresh assistant message (and clear toolSinceText)
        // so the reasoning groups with the answer below the tool cards — and the
        // subsequent text chunk lands in the same bubble rather than a new one.
        if (!st.msgId || st.toolSinceText) {
          if (st.toolSinceText && st.msgId) store.emit('message_done', st.msgId)
          st.msgId = addAssistantMessage(store, threadId)
          st.toolSinceText = false
          st.currentText = ''
        }
        appendReasoning(store, st.msgId, chunk.text)
        st.writing = false
        activity(threadId)
        break
      }
      case 'text_replace': {
        st.msgId ??= addAssistantMessage(store, threadId)
        setMessageContent(store, st.msgId, chunk.text)
        st.currentText = chunk.text
        break
      }
      case 'tool_call': {
        st.msgId ??= addAssistantMessage(store, threadId)
        addToolCall(store, st.msgId, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: chunk.toolCall.args,
          status: 'running',
          result: null,
          ...(chunk.toolCall.kind !== undefined ? { kind: chunk.toolCall.kind } : {}),
        })
        st.toolSinceText = true
        st.writing = false
        activity(threadId)
        // First tool call counts as the agent responding — name in parallel.
        maybeNameThread(store, api, threadId)
        break
      }
      case 'tool_call_update': {
        if (st.msgId && findToolCall(store, st.msgId, chunk.toolCallId)) {
          updateToolCall(store, st.msgId, chunk.toolCallId, {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            ...(chunk.args !== undefined ? { args: chunk.args } : {}),
            ...(chunk.status !== undefined ? { status: chunk.status } : {}),
            ...(chunk.result !== undefined ? { result: chunk.result } : {}),
            ...(chunk.resultFormat !== undefined ? { resultFormat: chunk.resultFormat } : {}),
          })
        }
        st.writing = false
        activity(threadId)
        break
      }
      case 'tool_result': {
        if (st.msgId) {
          updateToolCall(store, st.msgId, chunk.toolCallId, {
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
            ...(chunk.editStats ? { editStats: chunk.editStats } : {}),
            ...(chunk.resultFormat ? { resultFormat: chunk.resultFormat } : {}),
          })
          if (chunk.toolCallId && !chunk.isError) {
            const toolCall = findToolCall(store, st.msgId, chunk.toolCallId)
            // Only the foreground thread may rebind: branch status is global to
            // the working tree, so a background thread reading HEAD would chase a
            // branch the active thread checked out.
            if (
              toolCall?.name === 'run_shell' &&
              threadId === store.getState().activeThreadId &&
              shellCommandMayChangeBranch(toolCall.args)
            ) {
              void syncThreadGitBranchAfterShell(store, api, threadId)
            }
            tryOpenFileFromResult(store, chunk.result)
          }
          // Tools are now executing — the model is idle. Kick off small-model
          // rollups (shell batch + whole-turn polish) so labels are ready by the
          // time the tools finish — never blocks delivery.
          maybeSummarizeCommands(store, api, threadId, st)
          maybeSummarizeToolTurn(store, api, threadId, st)
        }
        st.writing = false
        activity(threadId)
        break
      }
      case 'context_trimmed': {
        recordContextTrim(store, threadId, {
          contextWindow: chunk.contextWindow,
          historyBudget: chunk.historyBudget,
          estimatedTokens: chunk.estimatedTokens,
        })
        updateContextSnapshot(store, threadId, {
          contextWindow: chunk.contextWindow,
          conversationBudget: chunk.historyBudget,
          conversationTokens: chunk.estimatedTokens,
          fillRatio: chunk.estimatedTokens / chunk.historyBudget,
        })
        store.emit('agent_activity', threadId, CONTEXT_TRIM_ACTIVITY)
        break
      }
      case 'usage': {
        const delta: UsageDelta = {
          model: chunk.model,
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          ...(chunk.cacheReadTokens !== undefined
            ? { cacheReadTokens: chunk.cacheReadTokens }
            : {}),
          ...(chunk.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: chunk.cacheCreationTokens }
            : {}),
          ...(chunk.usageSource !== undefined ? { usageSource: chunk.usageSource } : {}),
        }
        recordUsageToLedger(api, store, threadId, delta)
        addUsageDelta(store, threadId, delta)
        break
      }
      case 'context_pressure': {
        updateContextSnapshot(store, threadId, {
          contextWindow: chunk.contextWindow,
          conversationBudget: chunk.conversationBudget,
          conversationTokens: chunk.conversationTokens,
          fillRatio: chunk.fillRatio,
        })
        break
      }
      case 'subagent_start': {
        st.msgId ??= addAssistantMessage(store, threadId)
        initSubagent(store, st.msgId, chunk.parentToolCallId, chunk.session)
        st.writing = false
        activity(threadId)
        break
      }
      case 'subagent_text': {
        if (st.msgId) {
          appendSubagentText(store, st.msgId, chunk.parentToolCallId, chunk.messageId, chunk.text)
        }
        break
      }
      case 'subagent_tool_call': {
        if (st.msgId) {
          addSubagentToolCall(store, st.msgId, chunk.parentToolCallId, chunk.messageId, {
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            args: chunk.toolCall.args,
            status: 'running',
            result: null,
          })
        }
        activity(threadId)
        break
      }
      case 'subagent_tool_result': {
        if (st.msgId) {
          updateSubagentToolCall(store, st.msgId, chunk.parentToolCallId, chunk.toolCallId, {
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
            ...(chunk.editStats ? { editStats: chunk.editStats } : {}),
          })
        }
        activity(threadId)
        break
      }
      case 'subagent_done': {
        if (st.msgId) {
          finishSubagent(
            store,
            st.msgId,
            chunk.parentToolCallId,
            chunk.summary,
            'done',
            chunk.usage,
          )
        }
        activity(threadId)
        break
      }
      case 'subagent_error': {
        if (st.msgId) {
          finishSubagent(store, st.msgId, chunk.parentToolCallId, chunk.error, 'error')
        }
        activity(threadId)
        break
      }
      case 'todo_update': {
        setThreadTodos(store, threadId, chunk.todos)
        activity(threadId)
        break
      }
      case 'panel_update': {
        // P4: the todos pack emits `panel_update` alongside `todo_update` (the
        // ACP bridge maps it for external clients). The renderer already drives
        // the plan panel from `thread.todos` via the `todo_update` above, so the
        // chunk is redundant here — ignore it explicitly rather than through a
        // fall-through so the exhaustiveness check stays meaningful.
        break
      }
      case 'todo_worker_start':
      case 'todo_worker_done': {
        activity(threadId)
        break
      }
      case 'post_turn_review': {
        // Anchor the review to the turn's final assistant message so it renders
        // inline right after that turn. `st.msgId` is the current turn's message
        // and is still live here (the deferred `done` clears turn state later);
        // fall back to the thread's last message for a tool-only turn.
        const anchorId = st.msgId ?? getThreadById(store, threadId)?.messages.at(-1)?.id ?? null
        if (anchorId) {
          setMessageReview(store, threadId, anchorId, {
            status: chunk.status,
            summary: chunk.summary,
            ...(chunk.issuesFound !== undefined ? { issuesFound: chunk.issuesFound } : {}),
          })
        }
        if (chunk.status === 'running') store.emit('agent_activity', threadId, 'Reviewing changes…')
        break
      }
      case 'model_comparison': {
        setThreadComparison(store, threadId, chunk.comparison)
        if (chunk.comparison.status === 'running') {
          store.emit('agent_activity', threadId, 'Comparing models…')
        }
        break
      }
      case 'hook_run': {
        // Anchor the hook card to the turn's live message so the hook-card
        // family renders inline (decision 10). Prefer the current assistant
        // message; fall back to the thread's last message (a hook can fire
        // before the first assistant token, e.g. `beforeSubmitPrompt`). If the
        // thread has no message yet, the card will fold from the spine on reload.
        const anchorId = st.msgId ?? getThreadById(store, threadId)?.messages.at(-1)?.id ?? null
        if (anchorId) addHookCard(store, anchorId, chunk.card)
        activity(threadId)
        break
      }
      case 'continuation_budget': {
        // C3 run→drain fold-back (decision 5 / E3): record the machine turns this
        // run spent in-process so the next queue drain respects the shared cap.
        // Arrives just before `done`, which triggers the drain.
        foldBackContinuationUsed(store, threadId, chunk.turnTreeId, chunk.used)
        break
      }
      case 'done': {
        if (st.msgId) store.emit('message_done', st.msgId)
        state.delete(threadId)
        setThreadStatus(store, threadId, 'idle')
        store.emit('agent_activity', threadId, null)
        // The turn may have ended on a different branch than it started.
        // External ACP agents run their own tools, so the mid-turn `run_shell`
        // sync above never sees their checkouts; one HEAD read per turn keeps
        // the foreground thread's bound branch tracking reality.
        if (threadId === store.getState().activeThreadId) {
          void syncThreadGitBranchAfterShell(store, api, threadId)
        }
        drainMessageQueue(store, api, threadId)
        break
      }
    }
  })

  api.diff.onShowDiff((projectId, threadId, path, before, after, language) => {
    if (!isActiveOwner(projectId, threadId)) return
    store.setState({
      activeDiff: { path, before, after, language },
      rightPanelMode: 'changes',
      filesPaneOpen: true,
    })
    store.emit('panel_changed')
    store.emit('right_panel_mode_changed')
    store.emit('files_pane_changed')
  })

  // Diff IPC → store: `agent:show_diff` sets activeDiff; `diff:queued` updates
  // stagedDiffs (path/language only). The Changes panel caches full payloads from
  // show_diff for multi-file switching; approve/reject use diff:* IPC handlers.
  // C2: an async hook's queued message (decision 4) arrives here and lands in the
  // thread's pending queue with its origin + epoch. `enqueueHookMessage` owns the
  // staleness check (decision 16): a stale send-now is downgraded to held instead
  // of aborting an unrelated turn.
  const unsubHookQueue = api.agent.onHookQueueMessage((payload) => {
    enqueueHookMessage(store, api, payload.threadId, {
      text: payload.text,
      origin: payload.origin,
      epoch: payload.epoch,
      sendNow: payload.sendNow,
    })
  })

  api.diff.onQueued((projectId, threadId, entries) => {
    diffQueuesByOwner.set(ownerKey(projectId, threadId), entries)
    if (isActiveOwner(projectId, threadId)) publishActiveQueue(entries)
  })

  let publishedOwnerKey = ownerKey(
    store.getState().activeProjectId ?? '',
    store.getState().activeThreadId ?? '',
  )
  const syncDiffOwner = (): void => {
    const { activeProjectId, activeThreadId } = store.getState()
    const nextOwnerKey = ownerKey(activeProjectId ?? '', activeThreadId ?? '')
    if (nextOwnerKey === publishedOwnerKey) return
    publishedOwnerKey = nextOwnerKey
    const entries =
      activeProjectId && activeThreadId
        ? (diffQueuesByOwner.get(ownerKey(activeProjectId, activeThreadId)) ?? [])
        : []
    publishActiveQueue(entries)
  }
  const unsubDiffWorkspace = store.on('workspace_changed', syncDiffOwner)
  const unsubDiffThreads = store.on('threads_changed', syncDiffOwner)

  return () => {
    unsub()
    unsubHookQueue()
    unsubDiffWorkspace()
    unsubDiffThreads()
  }
}

type AgentState = {
  msgId: string | null
  summaryMsgId: string | null
  summaryCount: number
  toolSummaryMsgId: string | null
  toolSummaryCount: number
}

// Generate (or regenerate) a rolled-up label for the current message's batch of
// shell commands using the small-tasks model. Fired while tools execute so the
// summary lands during the model's idle window; guarded so each message is only
// summarized once per distinct command count. Silently no-ops for <2 commands
// (nothing to roll up) or when no small-tasks model is configured.
function maybeSummarizeCommands(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  st: AgentState,
): void {
  const msgId = st.msgId
  if (!msgId) return
  const msg = getThreadById(store, threadId)?.messages.find((m) => m.id === msgId)
  if (!msg) return

  const commands = shellCommandsFromToolCalls(msg.toolCalls)
  if (commands.length < 2) return
  if (st.summaryMsgId === msgId && st.summaryCount === commands.length) return
  st.summaryMsgId = msgId
  st.summaryCount = commands.length

  void (async (): Promise<void> => {
    let summary: string | null
    try {
      summary = await api.agent.suggestCommandSummary(commands)
    } catch {
      summary = null
    }
    if (summary?.trim()) setMessageCommandSummary(store, msgId, summary.trim())
  })()
}

// Polish the turn's canned tool rollup (`Used N tools`) with a short past-tense
// phrase from the small-tasks model. Non-blocking: the deterministic label stays
// until this resolves. Skips subagent cards and single-tool turns.
function maybeSummarizeToolTurn(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  st: AgentState,
): void {
  const msgId = st.msgId
  if (!msgId) return
  const msg = getThreadById(store, threadId)?.messages.find((m) => m.id === msgId)
  if (!msg) return

  const regular = msg.toolCalls.filter((tc) => !tc.subagent)
  if (regular.length < 2) return
  if (st.toolSummaryMsgId === msgId && st.toolSummaryCount === regular.length) return
  st.toolSummaryMsgId = msgId
  st.toolSummaryCount = regular.length

  const actions = regular.map((tc) => getToolCallLabel(tc))
  void (async (): Promise<void> => {
    let summary: string | null
    try {
      summary = await api.agent.suggestToolTurnSummary(actions)
    } catch {
      summary = null
    }
    if (summary?.trim()) setMessageToolSummary(store, msgId, summary.trim())
  })()
}

function tryOpenFileFromResult(_store: AppStore, _result: string): void {
  // If tool result is file content (read_file), open it in the panel
  // Convention: read_file returns the content directly; we use the store's pending openFile
  // The main process sends agent:show_diff for write_file — handled separately
}
