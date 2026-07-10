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
  setThreadStatus,
  setThreadTitle,
  addUsageDelta,
  recordContextTrim,
  updateContextSnapshot,
  setThreadTodos,
  setMessageReview,
  setThreadComparison,
  getThreadById,
} from '@shared/store/thread-helpers.ts'
import { syncThreadGitBranchAfterShell } from './sync-thread-branch-after-shell.ts'
import { shellCommandMayChangeBranch } from '@shared/git/sync-thread-branch.ts'
import { shellCommandsFromToolCalls } from '@shared/tools/tool-display.ts'
import {
  initSubagent,
  appendSubagentText,
  addSubagentToolCall,
  updateSubagentToolCall,
  finishSubagent,
} from '@shared/store/subagent-helpers.ts'
import { planAgentTextChunk } from '@copse/agent/agent-text-chunk.ts'
import { syncAgentActivity, CONTEXT_TRIM_ACTIVITY } from '../agent-activity.ts'
import { drainMessageQueue } from './message-queue.ts'
import { usageRecordFromAgentDelta } from '@shared/usage/usage-record-input.ts'
import type { UsageDelta } from '@shared/types'

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
      }
      state.set(tid, st)
    }
    return st
  }
  const activity = (tid: string): void => {
    syncAgentActivity(store, tid, get(tid).writing)
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
          st.msgId = addMessage(store, threadId, 'assistant')
        }
        st.toolSinceText = nextState.toolSinceText
        st.currentText = nextState.currentText ?? ''
        if (st.msgId === null) throw new Error('assistant message id missing for text chunk')
        appendToken(store, st.msgId, plan.text)

        if (plan.text.trim()) {
          st.writing = true
          activity(threadId)
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
          st.msgId = addMessage(store, threadId, 'assistant')
          st.toolSinceText = false
          st.currentText = ''
        }
        appendReasoning(store, st.msgId, chunk.text)
        st.writing = false
        activity(threadId)
        break
      }
      case 'text_replace': {
        if (!st.msgId) st.msgId = addMessage(store, threadId, 'assistant')
        setMessageContent(store, st.msgId, chunk.text)
        st.currentText = chunk.text
        break
      }
      case 'tool_call': {
        if (!st.msgId) st.msgId = addMessage(store, threadId, 'assistant')
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
          // Tools are now executing — the model is idle. Kick off a small-model
          // rollup summary for this message's shell batch so the group header is
          // ready by the time the commands finish.
          maybeSummarizeCommands(store, api, threadId, st)
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
        if (!st.msgId) st.msgId = addMessage(store, threadId, 'assistant')
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
        void maybeNameThread(store, api, threadId)
        drainMessageQueue(store, api, threadId)
        break
      }
    }
  })

  // Legacy path: some callers may still emit agent:usage directly.
  api.agent.onUsage((threadId, usage) => {
    recordUsageToLedger(api, store, threadId, usage)
    addUsageDelta(store, threadId, usage)
  })

  api.diff.onShowDiff((path, before, after, language) => {
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
  api.diff.onQueued((entries) => {
    const { activeDiff } = store.getState()
    const stillQueued =
      activeDiff && entries.some((e) => e.path === activeDiff.path) ? activeDiff : null
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
  })

  return unsub
}

type AgentState = {
  msgId: string | null
  summaryMsgId: string | null
  summaryCount: number
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

// Threads we've already attempted to auto-name, to avoid repeat calls.
const namedThreads = new Set<string>()

function firstWords(text: string, n = 6): string {
  return text.split(/\s+/).slice(0, n).join(' ').slice(0, 60) || 'New Thread'
}

// After a thread's first exchange completes, derive a title from the first user
// message — using the configured small-tasks model, with a plain word-slice
// fallback.
async function maybeNameThread(store: AppStore, api: ApiClient, threadId: string): Promise<void> {
  if (namedThreads.has(threadId)) return
  const thread = getThreadById(store, threadId)
  if (!thread || thread.title !== 'New Thread') return
  const firstUser = thread.messages.find((m) => m.role === 'user')
  if (!firstUser || !firstUser.content.trim()) return
  namedThreads.add(threadId)

  let title: string | null
  try {
    title = await api.agent.suggestTitle(firstUser.content)
  } catch {
    title = null
  }
  setThreadTitle(store, threadId, title?.trim() || firstWords(firstUser.content))
}

function tryOpenFileFromResult(_store: AppStore, _result: string): void {
  // If tool result is file content (read_file), open it in the panel
  // Convention: read_file returns the content directly; we use the store's pending openFile
  // The main process sends agent:show_diff for write_file — handled separately
}
