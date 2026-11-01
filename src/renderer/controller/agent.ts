import { acceptThreadPrompt } from './thread-prompts.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  findToolCall,
  setMessageCommandSummary,
  setMessageToolSummary,
  setMessageRunSummary,
  getThreadById,
  markThreadUnread,
  patchThreadAnywhere,
  getThreadProjectId,
} from '@shared/store/thread-helpers.ts'
import { transcriptMeta } from '@shared/store/transcript-state.ts'
import { acceptRuntimeThreadMeta } from './persistence.ts'
import { createTranscriptReducer } from '@shared/store/transcript-reducer.ts'
import { syncThreadGitBranchAfterShell } from './sync-thread-branch-after-shell.ts'
import { shellCommandMayChangeBranch } from '@shared/git/sync-thread-branch.ts'
import { getToolCallLabel, shellCommandsFromToolCalls } from '@shared/tools/tool-display.ts'
import { toolRunForMessage } from '@shared/tools/tool-runs.ts'
import { syncAgentActivity, CONTEXT_TRIM_ACTIVITY, promptProgressLabel } from '../agent-activity.ts'
import { drainMessageQueue, enqueueHookMessage, foldBackContinuationUsed } from './message-queue.ts'
import { attachDiffState } from './diff-state.ts'
import { maybeNameThread, maybeRenameThreadBranch } from './thread-naming.ts'
import { takeQuietRun } from './quiet-runs.ts'
import {
  clearReviewReportTarget,
  failRunningReviewReport,
  getReviewReportTarget,
} from './review-report-target.ts'
import { takeSendNowAbort } from './send-now-aborts.ts'
import { backgroundProjectOf, dropBackgroundThread } from './background-threads.ts'
import { applyRuntimeOwnedChunk, isRuntimeOwnedMessage } from './runtime-transcript.ts'
import type { Message, TranscriptAnnotation } from '@shared/types'
import { mark as perfMark } from '../perf.ts'

export function startAgentController(store: AppStore, api: ApiClient): () => void {
  // Window-only per-thread state. The transcript's own streaming state lives in
  // the shared reducer, which main runs too.
  type ThreadUiState = {
    // Which message we've already requested a command summary for, and at what
    // shell-command count, so we re-summarize only when more commands arrive.
    summaryMsgId: string | null
    summaryCount: number
    // Same guard for the whole-turn tool rollup polish (`toolSummary`).
    toolSummaryMsgId: string | null
    toolSummaryCount: number
    // Same guard for the cross-message run rollup polish (`runSummary`), keyed
    // on the run's anchor rather than the streaming message.
    runSummaryAnchorId: string | null
    runSummaryCount: number
    // Last activity label this thread emitted, so progress chunks that round
    // to the same percent do not re-announce through the aria-live region.
    // Every emit below records it: a key that only tracked progress would go
    // stale behind an intervening label and suppress the emit that restores it.
    lastActivityLabel: string | null
    firstActivityTraced: boolean
  }
  const ui = new Map<string, ThreadUiState>()
  const get = (tid: string): ThreadUiState => {
    let st = ui.get(tid)
    if (!st) {
      st = {
        summaryMsgId: null,
        summaryCount: 0,
        toolSummaryMsgId: null,
        toolSummaryCount: 0,
        runSummaryAnchorId: null,
        runSummaryCount: 0,
        lastActivityLabel: null,
        firstActivityTraced: false,
      }
      ui.set(tid, st)
    }
    return st
  }
  const emitActivity = (tid: string, label: string | null): void => {
    get(tid).lastActivityLabel = label
    store.emit('agent_activity', tid, label)
  }

  // Ids main minted for the messages the chunk being applied creates, consumed
  // in creation order. Empty for an unstamped chunk, which mints its own.
  let stampedIds: string[] = []

  const reducer = createTranscriptReducer(store, {
    createMessageId: () => stampedIds.shift(),
    userAbort: (threadId) => (takeSendNowAbort(threadId) ? 'send_now' : 'stop'),
    reviewReportTarget: (threadId) => getReviewReportTarget(store, threadId),
    reviewReportSettled: (threadId) => {
      clearReviewReportTarget(store, threadId)
    },
    turnStarted: (threadId) => {
      get(threadId).firstActivityTraced = false
    },
    activity: (threadId, writing) => {
      get(threadId).lastActivityLabel = syncAgentActivity(store, threadId, writing)
    },
    activityLabel: (threadId, phase) => {
      emitActivity(
        threadId,
        phase === 'context_trimmed' ? CONTEXT_TRIM_ACTIVITY : 'Reviewing changes…',
      )
    },
    promptProgress: (threadId, fraction) => {
      // Progress callbacks can arrive far more often than the label's whole
      // percent changes; skip the emit when rounding collapses them, so the
      // aria-live region is not re-announced with an unchanged string.
      const label = promptProgressLabel(fraction)
      if (label !== get(threadId).lastActivityLabel) emitActivity(threadId, label)
    },
    setupProgress: (threadId, label) => {
      // A repeated stage is not re-announced to the aria-live region.
      if (label !== get(threadId).lastActivityLabel) emitActivity(threadId, label)
    },
    visibleOutput: (threadId) => {
      maybeNameThread(store, api, threadId)
    },
    toolResult: (threadId, ownerId, chunk) => {
      if (chunk.toolCallId && !chunk.isError) {
        const toolCall = findToolCall(store, ownerId, chunk.toolCallId)
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
      }
      // Tools are now executing — the model is idle. Kick off small-model
      // rollups (shell batch + whole-turn polish) so labels are ready by the
      // time the tools finish — never blocks delivery.
      const msgId = reducer.streamingMessageId(threadId)
      const st = get(threadId)
      maybeSummarizeCommands(store, api, threadId, msgId, st)
      maybeSummarizeToolTurn(store, api, threadId, msgId, st)
      maybeSummarizeToolRun(store, api, threadId, msgId, st)
    },
    continuationBudget: (threadId, turnTreeId, used) => {
      foldBackContinuationUsed(store, threadId, turnTreeId, used)
    },
    beforeIdle: (threadId) => {
      ui.delete(threadId)
      // A standalone review that ends without its final report — main could
      // not resolve the thread's checkout, say, and streamed only an error
      // text before `done` — must not leave its card spinning.
      const reviewTarget = getReviewReportTarget(store, threadId)
      if (reviewTarget !== undefined) {
        failRunningReviewReport(
          store,
          threadId,
          reviewTarget,
          'The review ended before it produced a report.',
        )
        clearReviewReportTarget(store, threadId)
      }
      // A send-now that raced a run already finishing leaves an unused mark.
      takeSendNowAbort(threadId)
    },
    turnDone: (threadId) => {
      finishTurn(threadId)
    },
  })

  const finishTurn = (threadId: string): void => {
    maybeRenameThreadBranch(store, api, threadId)
    // Not emitActivity: the window state entry is gone, and recording the label
    // on a fresh one would leak an entry per finished turn. The next turn
    // starts from a null key anyway.
    store.emit('agent_activity', threadId, null)
    // The turn may have ended on a different branch than it started.
    // External ACP agents run their own tools, so the mid-turn `run_shell`
    // sync above never sees their checkouts; one HEAD read per turn keeps
    // the foreground thread's bound branch tracking reality.
    if (threadId === store.getState().activeThreadId) {
      void syncThreadGitBranchAfterShell(store, api, threadId)
    }
    const backgroundProjectId = backgroundProjectOf(store, threadId)
    const backgroundProjectWasRemoved =
      backgroundProjectId !== undefined &&
      !store.getState().projects.some((project) => project.id === backgroundProjectId)
    if (backgroundProjectId) {
      // Autosave's reconcile only covers the active project, so a carried
      // run's final metadata (idle status, usage, todos) would otherwise
      // stay `running` on disk until the project is revisited — or forever,
      // if the app quits first (#1841). Write it directly. The queue is
      // persisted before the owner-aware queue dispatches its next prompt.
      const finished = getThreadById(store, threadId)
      if (finished) {
        void api.threads
          .updateMeta(backgroundProjectId, threadId, {
            status: finished.status,
            usage: finished.usage,
            updatedAt: finished.updatedAt,
            title: finished.title,
            pendingMessages: finished.pendingMessages ?? [],
            continuationUsed: finished.continuationUsed ?? 0,
            crossThreadPromptsUsed: finished.crossThreadPromptsUsed ?? 0,
            crossThreadPromptCounts: finished.crossThreadPromptCounts ?? {},
            ...(finished.currentEpoch !== undefined ? { currentEpoch: finished.currentEpoch } : {}),
            ...(finished.todos !== undefined ? { todos: finished.todos } : {}),
          })
          .catch((err: unknown) => {
            console.error('[threads] could not persist a background run finish', err)
          })
      }
    }
    if (!backgroundProjectWasRemoved) drainMessageQueue(store, api, threadId)
    // A queued user or machine continuation immediately flips the thread
    // back to running. Only alert when the queue drain leaves it genuinely
    // finished, rather than chiming between consecutive turns — and never
    // for a run the user launched from the foreground and is watching.
    const finishedThread = getThreadById(store, threadId)
    const quiet = takeQuietRun(threadId)
    if (finishedThread?.status === 'idle') {
      markThreadUnread(store, threadId)
      if (!quiet) {
        void api.alerts.threadFinished(threadId, finishedThread.title).catch((error: unknown) => {
          console.error('[alerts] failed to signal thread completion:', error)
        })
      }
    }
    // Removing an inactive project from the sidebar must not detach its
    // live run. `removeProject` keeps the carried entry until this final
    // message/meta handling is complete, after which nothing else needs
    // the in-memory copy.
    if (backgroundProjectWasRemoved) dropBackgroundThread(store, threadId)
  }

  // Diff IPC → store. Shared with pop-out windows, which run this wiring alone
  // because they deliberately do not start the rest of the agent controller.
  const detachDiffState = attachDiffState(store, api, { revealOnShowDiff: true })

  const attached = new Set<string>()
  const unsubSnapshot = api.agent.onTranscriptSnapshot(({ projectId, thread, checkpoint }) => {
    if (getThreadProjectId(store, thread.id) !== projectId) return
    applyRuntimeOwnedChunk(
      thread.messages.map((message) => message.id),
      () => {
        patchThreadAnywhere(store, thread.id, (current) => {
          return {
            ...current,
            ...transcriptMeta(thread),
            // Queue recovery may already have proven the persisted run died.
            // An idle attachment's disk snapshot must not resurrect that stale
            // running flag after recovery has offered an explicit retry.
            ...(current.interruptedTurnAt !== undefined &&
            checkpoint.stream === null &&
            checkpoint.pendingTurn === null
              ? { status: current.status }
              : {}),
            messages: mergeRuntimeMessages(current.messages, thread.messages),
          }
        })
        reducer.restore(thread.id, checkpoint)
        attached.add(thread.id)
        const current = getThreadById(store, thread.id)
        if (current) acceptRuntimeThreadMeta(projectId, current)
        store.emit('threads_changed')
        syncAgentActivity(store, thread.id, checkpoint.stream?.writing ?? false)
      },
    )
  })
  const attach = (): void => {
    const { activeProjectId, threads } = store.getState()
    if (!activeProjectId) return
    void api.agent
      .attachTranscripts(
        activeProjectId,
        threads.map((thread) => thread.id),
      )
      .catch((error: unknown) => {
        console.error('[threads] could not attach transcripts:', error)
      })
  }
  const unsubWorkspace = store.on('workspace_changed', attach)
  attach()

  const unsub = api.agent.onChunk((threadId, chunk, stamp) => {
    // A new turn sends its snapshot before its first chunk. A reloaded window
    // ignores missed-prefix chunks until attachment restores that checkpoint.
    if (stamp && !attached.has(threadId)) return
    const st = get(threadId)
    const firstVisibleActivity =
      chunk.type === 'tool_call' ||
      chunk.type === 'acp_content' ||
      chunk.type === 'acp_content_replace' ||
      (chunk.type === 'text' && chunk.text.trim() !== '') ||
      (chunk.type === 'reasoning' && chunk.text.trim() !== '')
    if (firstVisibleActivity && !st.firstActivityTraced) {
      st.firstActivityTraced = true
      perfMark('ttft:renderer-first-activity', { kind: chunk.type })
    }
    if (!stamp) {
      reducer.apply(threadId, chunk)
      return
    }
    stampedIds = [...stamp.messageIds]
    const previous = getThreadById(store, threadId)
    const beforeMeta = previous ? structuredClone(transcriptMeta(previous)) : undefined
    try {
      applyRuntimeOwnedChunk(stamp.messageIds, () => {
        reducer.apply(threadId, chunk)
        const thread = getThreadById(store, threadId)
        const projectId = getThreadProjectId(store, threadId)
        if (thread && projectId) acceptRuntimeThreadMeta(projectId, thread, beforeMeta)
      })
    } finally {
      stampedIds = []
    }
  })

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

  const unsubThreadPrompts = api.threadPrompts.onPrompt((command) => {
    void acceptThreadPrompt(store, api, command)
      .then((result) => api.threadPrompts.reply(command.id, result))
      .catch((error: unknown) => {
        console.error('[threads] failed to acknowledge prompt:', error)
      })
  })

  return () => {
    unsub()
    unsubHookQueue()
    unsubSnapshot()
    unsubWorkspace()
    unsubThreadPrompts()
    detachDiffState()
  }
}

type SummaryGuards = {
  summaryMsgId: string | null
  summaryCount: number
  toolSummaryMsgId: string | null
  toolSummaryCount: number
  runSummaryAnchorId: string | null
  runSummaryCount: number
}

/**
 * Show a small-model label at once, and make it durable. A message main owns is
 * main's to write, so the label goes to main to merge into its copy; writing the
 * window's copy instead could land over a newer one main wrote meanwhile.
 * Anything else is persisted by the autosave from the same store event.
 */
function applySummary(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  messageId: string,
  annotation: TranscriptAnnotation,
): void {
  if (annotation.commandSummary !== undefined) {
    setMessageCommandSummary(store, messageId, annotation.commandSummary)
  }
  if (annotation.toolSummary !== undefined) {
    setMessageToolSummary(store, messageId, annotation.toolSummary)
  }
  if (annotation.runSummary !== undefined) {
    setMessageRunSummary(store, messageId, annotation.runSummary)
  }
  if (!isRuntimeOwnedMessage(messageId)) return
  const projectId = backgroundProjectOf(store, threadId) ?? store.getState().activeProjectId
  if (!projectId) return
  void api.threads
    .annotateMessage(projectId, threadId, messageId, annotation)
    .catch((err: unknown) => {
      console.error('[threads] could not save a summary label', err)
    })
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
  msgId: string | null,
  st: SummaryGuards,
): void {
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
    if (summary?.trim()) {
      applySummary(store, api, threadId, msgId, { commandSummary: summary.trim() })
    }
  })()
}

// Polish the turn's canned tool rollup (`Used N tools`) with a short past-tense
// phrase from the small-tasks model. Non-blocking: the deterministic label stays
// until this resolves. Skips subagent cards and single-tool turns.
function maybeSummarizeToolTurn(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  msgId: string | null,
  st: SummaryGuards,
): void {
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
    if (summary?.trim()) {
      applySummary(store, api, threadId, msgId, { toolSummary: summary.trim() })
    }
  })()
}

// Polish the *run* rollup — the summary shown when a burst of tool work spans
// several adjacent assistant messages. Same small-tasks service and the same
// non-blocking contract as the per-message polish above; the deterministic
// `Used N tools · M steps` label holds until it resolves. No-ops until the run
// actually spans more than one message, so an ordinary single-message turn
// never spends a second request.
function maybeSummarizeToolRun(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  msgId: string | null,
  st: SummaryGuards,
): void {
  if (!msgId) return
  const thread = getThreadById(store, threadId)
  if (!thread) return
  const run = toolRunForMessage(thread.messages, msgId)
  if (!run || run.steps.length < 2 || run.toolCalls.length < 2) return
  const requestCount = run.toolCalls.length
  if (st.runSummaryAnchorId === run.anchorId && st.runSummaryCount === requestCount) return
  st.runSummaryAnchorId = run.anchorId
  st.runSummaryCount = requestCount

  const actions = run.toolCalls.map((tc) => getToolCallLabel(tc))
  void (async (): Promise<void> => {
    let summary: string | null
    try {
      summary = await api.agent.suggestToolTurnSummary(actions)
    } catch {
      summary = null
    }
    // A run only ever grows, so the tool count identifies each request for an
    // anchor. If a later request for this same anchor has since gone out, its
    // reply covers more of the run than ours — drop ours rather than let a
    // slower earlier request overwrite a newer summary.
    if (st.runSummaryAnchorId === run.anchorId && st.runSummaryCount !== requestCount) return
    if (summary?.trim()) {
      applySummary(store, api, threadId, run.anchorId, { runSummary: summary.trim() })
    }
  })()
}

/** A seed read must not undo the window's queue placement or pending labels. */
function mergeRuntimeMessages(current: Message[], incoming: Message[]): Message[] {
  const messages = [...current]
  let previous = -1
  for (const message of incoming) {
    const index = messages.findIndex((candidate) => candidate.id === message.id)
    if (index < 0) {
      previous += 1
      messages.splice(previous, 0, message)
      continue
    }
    const local = messages[index]
    messages[index] = {
      ...local,
      ...message,
    }
    previous = index
  }
  return messages
}
