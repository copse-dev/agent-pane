import { classifyAutomationFailureMessage } from '@shared/automation-failure.ts'
import { MATCH_PROMPT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import { planAgentTextChunk } from '@copse/agent/agent-text-chunk.ts'
import type { StreamChunk, TurnOutcome, UsageDelta } from '@shared/types'
import { userContentToText } from '@shared/remote-agent-stream.ts'
import type { AppStore } from './store.ts'
import {
  addMessage,
  appendToken,
  appendReasoning,
  appendAcpContentBlock,
  addMessageCanvasArtefact,
  addMessageVisualEvidence,
  addToolCall,
  updateToolCall,
  findToolCallOwner,
  setMessageContent,
  setThreadStatus,
  markAutomationRunFailed,
  addUsageDelta,
  recordContextTrim,
  updateContextSnapshot,
  setThreadTodos,
  setMessageReview,
  setMessageTurnOutcome,
  setThreadReviewReport,
  setMessageReviewReport,
  addHookCard,
  getThreadById,
  applyPreparedThreadCheckout,
  patchThreadAnywhere,
} from './thread-helpers.ts'
import {
  initSubagent,
  appendSubagentReasoning,
  appendSubagentText,
  addSubagentToolCall,
  updateSubagentToolCall,
  finishSubagent,
} from './subagent-helpers.ts'

/**
 * The chunk → `Message` reduction for one agent stream, shared by the two
 * processes that hold a transcript.
 *
 * Main runs it against a headless store as the transcript's only writer
 * (`src/main/services/turn-transcript-writer.ts`); the renderer runs it against
 * the app store to draw the same turn live. Both see the same chunks in the same
 * order, and main tells the renderer the id of every message it creates, so the
 * two copies agree message for message. Everything that is only about the
 * window — activity labels, naming, small-model summaries, alerts, the queue —
 * stays with the renderer behind {@link TranscriptReducerHooks}.
 *
 * Keep this module free of DOM and Electron: main imports it.
 */
export interface TranscriptReducerHooks {
  /** The id for the next message this stream creates; `undefined` mints one. */
  createMessageId?: (threadId: string) => string | undefined
  /** The model a bubble records when neither the turn nor the thread names one. */
  defaultModel?: () => string | undefined
  /** How a user Stop is labelled. Main cannot tell a Stop from a send-now. */
  userAbort?: (threadId: string) => 'send_now' | 'stop'
  /** A standalone review asked for its report to land on this message. */
  reviewReportTarget?: (threadId: string) => string | null | undefined
  reviewReportSettled?: (threadId: string) => void
  turnStarted?: (threadId: string) => void
  activity?: (threadId: string, writing: boolean) => void
  /** A labelled phase began; the renderer owns the wording. */
  activityLabel?: (threadId: string, phase: TranscriptActivityPhase) => void
  promptProgress?: (threadId: string, fraction: number) => void
  /** A stage of reaching a remote agent began; `label` is the row's wording. */
  setupProgress?: (threadId: string, label: string) => void
  /** Visible assistant output arrived: the renderer names the thread from it. */
  visibleOutput?: (threadId: string) => void
  toolResult?: (threadId: string, ownerId: string, chunk: ToolResultChunk) => void
  continuationBudget?: (threadId: string, turnTreeId: string, used: number) => void
  /** `done` arrived; runs before the thread is marked idle. */
  beforeIdle?: (threadId: string) => void
  /** `done` arrived; runs after the thread is marked idle. */
  turnDone?: (threadId: string) => void
}

export type ToolResultChunk = Extract<StreamChunk, { type: 'tool_result' }>

export type TranscriptActivityPhase = 'context_trimmed' | 'reviewing'

export interface TranscriptReducer {
  apply(threadId: string, chunk: StreamChunk): void
  /** The assistant message the thread's stream is writing into, if any. */
  streamingMessageId(threadId: string): string | null
  checkpoint(threadId: string): TranscriptCheckpoint
  restore(threadId: string, checkpoint: TranscriptCheckpoint): void
}

export interface TranscriptCheckpoint {
  stream: StreamState | null
  pendingTurn: PendingTurn | null
}

/**
 * Resolved generation parameters, resolved model, and requested model for the
 * turn currently streaming. Main reports them once before the first token,
 * which is before the assistant bubble exists — so they are held here and
 * stamped onto the bubble the moment it is created. Cleared when the turn ends
 * so a later turn on an untuned model cannot inherit them.
 */
interface PendingTurn {
  parameters: ModelParameters
  /** The concrete route the turn actually ran on (after `auto:…` resolution). */
  model?: string
  /** The user's picker/requested selection (possibly a dynamic selector). */
  requestedModel?: string
}

// Per-thread streaming state: the message currently accumulating text, and
// whether a tool call has arrived since the last text chunk. When text resumes
// after tool calls, the current message is finalized and a new one started so
// the final answer renders BELOW the tool cards rather than above them.
interface StreamState {
  msgId: string | null
  toolSinceText: boolean
  // Accumulated visible text of the current assistant message, threaded into
  // planAgentTextChunk so a tool call that interrupts mid-sentence keeps the
  // resumed text in the same bubble.
  currentText: string
  writing: boolean
  acpMessageId: string | null
  acpThoughtMessageId: string | null
}

export function createTranscriptReducer(
  store: AppStore,
  hooks: TranscriptReducerHooks = {},
): TranscriptReducer {
  const state = new Map<string, StreamState>()
  const pendingTurn = new Map<string, PendingTurn>()
  const get = (threadId: string): StreamState => {
    let st = state.get(threadId)
    if (!st) {
      st = {
        msgId: null,
        toolSinceText: false,
        currentText: '',
        writing: false,
        acpMessageId: null,
        acpThoughtMessageId: null,
      }
      state.set(threadId, st)
    }
    return st
  }
  const activity = (threadId: string): void => {
    hooks.activity?.(threadId, get(threadId).writing)
  }

  /**
   * Stamp a new primary-chat assistant bubble. The resolved model (the concrete
   * route actually run) becomes the message `model`; the picker/requested
   * selection — which may be a dynamic selector like `auto:…` — is recorded
   * separately as `requestedModel`.
   */
  const addAssistantMessage = (threadId: string): string => {
    const held = pendingTurn.get(threadId)
    const requested =
      held?.requestedModel ??
      getThreadById(store, threadId)?.model ??
      (hooks.defaultModel ? hooks.defaultModel() : store.getState().settings?.model)
    const id = hooks.createMessageId?.(threadId)
    return addMessage(store, threadId, 'assistant', '', undefined, undefined, {
      ...(requested !== undefined ? { requestedModel: requested } : {}),
      ...(held?.model !== undefined ? { model: held.model } : {}),
      ...(held?.parameters !== undefined ? { parameters: held.parameters } : {}),
      ...(id !== undefined ? { id } : {}),
    })
  }

  // Close the current bubble when a new kind of output follows tool calls, so it
  // groups with the answer below the tool cards.
  const ensureFreshAfterTools = (threadId: string, st: StreamState): string => {
    if (!st.msgId || st.toolSinceText) {
      if (st.toolSinceText && st.msgId) store.emit('message_done', st.msgId)
      st.msgId = addAssistantMessage(threadId)
      st.toolSinceText = false
      st.currentText = ''
    }
    return st.msgId
  }

  const appendText = (threadId: string, st: StreamState, text: string): string | null => {
    const { plan, state: nextState } = planAgentTextChunk(
      { msgId: st.msgId, toolSinceText: st.toolSinceText, currentText: st.currentText },
      text,
    )
    if (plan.action === 'ignore') return null
    if (plan.startNewMessage) {
      if (plan.finalizeMsgId) store.emit('message_done', plan.finalizeMsgId)
      st.msgId = addAssistantMessage(threadId)
    }
    st.toolSinceText = nextState.toolSinceText
    st.currentText = nextState.currentText ?? ''
    if (st.msgId === null) throw new Error('assistant message id missing for agent text')
    appendToken(store, st.msgId, plan.text)
    return plan.text
  }

  const apply = (threadId: string, chunk: StreamChunk): void => {
    const st = get(threadId)
    switch (chunk.type) {
      case 'machine_turn_start': {
        hooks.turnStarted?.(threadId)
        setThreadStatus(store, threadId, 'running')
        if (chunk.hidden) break
        const id = hooks.createMessageId?.(threadId)
        addMessage(
          store,
          threadId,
          'user',
          userContentToText(chunk.content),
          undefined,
          chunk.attachments,
          {
            origin: chunk.origin,
            ...(chunk.startingCommit !== undefined ? { startingCommit: chunk.startingCommit } : {}),
            ...(chunk.dirty !== undefined ? { dirty: chunk.dirty } : {}),
            ...(id !== undefined ? { id } : {}),
          },
        )
        break
      }
      case 'text': {
        const text = appendText(threadId, st, chunk.text)
        if (text === null) break
        if (text.trim()) {
          st.writing = true
          activity(threadId)
          // First visible assistant output — start naming without waiting for `done`.
          hooks.visibleOutput?.(threadId)
        }
        break
      }
      case 'reasoning': {
        // Reasoning precedes this step's answer. If the previous step ended with
        // tool calls, start a fresh assistant message (and clear toolSinceText)
        // so the reasoning groups with the answer below the tool cards — and the
        // subsequent text chunk lands in the same bubble rather than a new one.
        appendReasoning(store, ensureFreshAfterTools(threadId, st), chunk.text)
        st.writing = false
        activity(threadId)
        break
      }
      case 'acp_content': {
        const previousId = chunk.channel === 'message' ? st.acpMessageId : st.acpThoughtMessageId
        const boundaryChanged =
          chunk.messageId !== undefined && previousId !== null && chunk.messageId !== previousId
        if (boundaryChanged && st.msgId) {
          store.emit('message_done', st.msgId)
          st.msgId = null
          st.toolSinceText = false
          st.currentText = ''
        }
        if (chunk.messageId !== undefined) {
          if (chunk.channel === 'message') st.acpMessageId = chunk.messageId
          else st.acpThoughtMessageId = chunk.messageId
        }

        if (chunk.content.type === 'text') {
          if (chunk.channel === 'thought') {
            appendReasoning(store, ensureFreshAfterTools(threadId, st), chunk.content.text)
            st.writing = false
          } else {
            const text = appendText(threadId, st, chunk.content.text)
            if (text === null) break
            st.writing = text.trim().length > 0
            if (st.writing) hooks.visibleOutput?.(threadId)
          }
        } else {
          const msgId = ensureFreshAfterTools(threadId, st)
          appendAcpContentBlock(store, msgId, chunk.channel, chunk.content)
          st.writing = false
          hooks.visibleOutput?.(threadId)
        }
        activity(threadId)
        break
      }
      case 'text_replace': {
        st.msgId ??= addAssistantMessage(threadId)
        setMessageContent(store, st.msgId, chunk.text)
        st.currentText = chunk.text
        break
      }
      case 'canvas_artefact': {
        // A reference can be the entire post-tool answer. Give it a fresh
        // assistant bubble just as reasoning or visible text would receive.
        addMessageCanvasArtefact(store, ensureFreshAfterTools(threadId, st), chunk.artefact)
        break
      }
      case 'tool_call': {
        // A pooled ACP session can replay a `tool_call` for an id this thread
        // already has — a straggler from a turn that has ended. Opening a second
        // card for it would put the previous turn's work under the new turn's
        // bubble, below the user's follow-up (#2332).
        if (findToolCallOwner(store, threadId, chunk.toolCall.id)) break
        st.msgId ??= addAssistantMessage(threadId)
        addToolCall(store, st.msgId, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          ...(chunk.toolCall.title !== undefined ? { title: chunk.toolCall.title } : {}),
          ...(chunk.toolCall.programmaticName !== undefined
            ? { programmaticName: chunk.toolCall.programmaticName }
            : {}),
          args: chunk.toolCall.args,
          status: 'running',
          result: null,
          ...(chunk.toolCall.kind !== undefined ? { kind: chunk.toolCall.kind } : {}),
        })
        st.toolSinceText = true
        st.writing = false
        activity(threadId)
        // First tool call counts as the agent responding — name in parallel.
        hooks.visibleOutput?.(threadId)
        break
      }
      case 'tool_call_update': {
        // Route by which message actually holds the call, not by whichever
        // message happens to be streaming: a straggler from a finished turn
        // otherwise patches — or silently misses — the wrong bubble (#2332).
        const ownerId = findToolCallOwner(store, threadId, chunk.toolCallId)
        if (ownerId) {
          updateToolCall(store, ownerId, chunk.toolCallId, {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            ...(chunk.title !== undefined ? { title: chunk.title } : {}),
            ...(chunk.programmaticName !== undefined
              ? { programmaticName: chunk.programmaticName }
              : {}),
            ...(chunk.args !== undefined ? { args: chunk.args } : {}),
            ...(chunk.kind !== undefined ? { kind: chunk.kind } : {}),
            ...(chunk.status !== undefined ? { status: chunk.status } : {}),
            ...(chunk.result !== undefined ? { result: chunk.result } : {}),
            ...(chunk.resultFormat !== undefined ? { resultFormat: chunk.resultFormat } : {}),
            ...(chunk.images !== undefined ? { images: chunk.images } : {}),
            ...(chunk.content !== undefined ? { content: chunk.content } : {}),
            ...(chunk.locations !== undefined ? { locations: chunk.locations } : {}),
          })
        }
        st.writing = false
        activity(threadId)
        break
      }
      case 'visual_evidence': {
        // Evidence is durable assistant-owned output: never guess its owner.
        // The loop emits this only after the publishing tool_call, so a missing
        // call means the event is stale or malformed and must not migrate onto
        // whichever message happens to be live.
        const ownerId = findToolCallOwner(store, threadId, chunk.toolCallId)
        if (ownerId) {
          addMessageVisualEvidence(store, ownerId, chunk.toolCallId, chunk.evidence)
        }
        break
      }
      case 'tool_result': {
        // Same ownership rule as `tool_call_update`: the result belongs to the
        // message that holds the call, which is not always the one streaming.
        const ownerId = findToolCallOwner(store, threadId, chunk.toolCallId) ?? st.msgId
        if (ownerId) {
          updateToolCall(store, ownerId, chunk.toolCallId, {
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
            ...(chunk.editStats ? { editStats: chunk.editStats } : {}),
            ...(chunk.resultFormat ? { resultFormat: chunk.resultFormat } : {}),
            ...(chunk.appendedReminderLengths
              ? { appendedReminderLengths: chunk.appendedReminderLengths }
              : {}),
            ...(chunk.images ? { images: chunk.images } : {}),
          })
          hooks.toolResult?.(threadId, ownerId, chunk)
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
        hooks.activityLabel?.(threadId, 'context_trimmed')
        break
      }
      case 'turn_parameters': {
        // Held rather than applied: the bubble this belongs to is created by the
        // first text/tool chunk, which has not arrived yet.
        pendingTurn.set(threadId, {
          parameters: chunk.parameters,
          model: chunk.model,
          ...(chunk.requestedModel !== undefined ? { requestedModel: chunk.requestedModel } : {}),
        })
        // Publish the route before the first bubble exists. Footer chrome reads
        // thread state, and a previous turn's persisted resolution may be stale.
        if (
          patchThreadAnywhere(store, threadId, (thread) => ({
            ...thread,
            resolvedModel: chunk.model,
            ...(chunk.requestedModel === MATCH_PROMPT_MODEL_SELECTOR &&
            (thread.model === undefined || thread.model === MATCH_PROMPT_MODEL_SELECTOR)
              ? { model: chunk.model }
              : {}),
          }))
        ) {
          store.emit('thread_model_resolved', threadId)
        }
        break
      }
      case 'usage': {
        const delta: UsageDelta = {
          model: chunk.model,
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          ...(chunk.subagentUsage ? { subagentUsage: true } : {}),
          ...(chunk.cacheReadTokens !== undefined
            ? { cacheReadTokens: chunk.cacheReadTokens }
            : {}),
          ...(chunk.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: chunk.cacheCreationTokens }
            : {}),
          ...(chunk.requestedServiceTier !== undefined
            ? { requestedServiceTier: chunk.requestedServiceTier }
            : {}),
          ...(chunk.responseServiceTier !== undefined
            ? { responseServiceTier: chunk.responseServiceTier }
            : {}),
          ...(chunk.serviceTierUsage !== undefined
            ? { serviceTierUsage: chunk.serviceTierUsage }
            : {}),
        }
        addUsageDelta(store, threadId, delta)
        break
      }
      case 'prompt_progress': {
        hooks.promptProgress?.(threadId, chunk.fraction)
        break
      }
      case 'agent_setup_progress': {
        // Status only: nothing reaches the transcript. Until the agent's first
        // token the row would otherwise say "Reasoning…" while Copse is still
        // connecting to or installing on a remote host. Once the agent is
        // reached, resync the row from thread state.
        if (chunk.phase === 'ready') activity(threadId)
        else hooks.setupProgress?.(threadId, chunk.label)
        break
      }
      case 'context_pressure': {
        updateContextSnapshot(store, threadId, {
          contextWindow: chunk.contextWindow,
          conversationBudget: chunk.conversationBudget,
          conversationTokens: chunk.conversationTokens,
          fillRatio: chunk.fillRatio,
          ...(chunk.source !== undefined ? { source: chunk.source } : {}),
          ...(chunk.cost !== undefined ? { cost: chunk.cost } : {}),
        })
        break
      }
      case 'subagent_start': {
        st.msgId ??= addAssistantMessage(threadId)
        initSubagent(store, st.msgId, chunk.parentToolCallId, chunk.session)
        st.writing = false
        activity(threadId)
        break
      }
      case 'subagent_reasoning': {
        if (st.msgId) {
          appendSubagentReasoning(
            store,
            st.msgId,
            chunk.parentToolCallId,
            chunk.messageId,
            chunk.text,
          )
        }
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
            ...(chunk.appendedReminderLengths
              ? { appendedReminderLengths: chunk.appendedReminderLengths }
              : {}),
            ...(chunk.images ? { images: chunk.images } : {}),
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
      case 'thread_checkout': {
        applyPreparedThreadCheckout(store, threadId, chunk.prepared)
        break
      }
      case 'panel_update': {
        // P4: the todos plugin emits `panel_update` alongside `todo_update` (the
        // ACP bridge maps it for external clients). The plan panel is driven
        // from `thread.todos` via the `todo_update` above, so the chunk is
        // redundant here — ignore it explicitly rather than through a
        // fall-through so the exhaustiveness check stays meaningful.
        break
      }
      case 'provider_state':
      case 'context_compacted': {
        // Provider bookkeeping. The opaque item never leaves the loop (it is kept
        // in provider history), and the boundary is recorded in the thread spine
        // by main; nothing to show or store here.
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
            ...(chunk.followUpNote !== undefined ? { followUpNote: chunk.followUpNote } : {}),
          })
        }
        if (chunk.status === 'running') hooks.activityLabel?.(threadId, 'reviewing')
        break
      }
      case 'review_report': {
        const thread = getThreadById(store, threadId)
        const requestedAnchor = hooks.reviewReportTarget?.(threadId)
        const anchorId =
          requestedAnchor !== undefined
            ? requestedAnchor
            : (st.msgId ??
              [...(thread?.messages ?? [])]
                .reverse()
                .find((message) => message.role === 'assistant')?.id ??
              null)
        if (anchorId === null) setThreadReviewReport(store, threadId, chunk.report)
        else setMessageReviewReport(store, threadId, anchorId, chunk.report)
        if (requestedAnchor !== undefined && chunk.report.status !== 'running') {
          hooks.reviewReportSettled?.(threadId)
        }
        if (chunk.report.status === 'running') {
          hooks.activityLabel?.(threadId, 'reviewing')
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
        // C3 run→drain fold-back (decision 5 / E3): the machine turns this run
        // spent in-process, so the next queue drain respects the shared cap.
        // Arrives just before `done`, which triggers the drain.
        hooks.continuationBudget?.(threadId, chunk.turnTreeId, chunk.used)
        break
      }
      case 'turn_outcome': {
        // Terminal diagnostics belong to the assistant bubble that concluded
        // the turn. A provider can fail before its first token, so create an
        // otherwise-empty bubble rather than dropping the only durable record.
        st.msgId ??= addAssistantMessage(threadId)
        const userCancelled =
          chunk.outcome.status === 'cancelled' && chunk.outcome.source === 'user'
        const outcome: TurnOutcome =
          userCancelled && chunk.outcome.userAbort === undefined
            ? { ...chunk.outcome, userAbort: hooks.userAbort?.(threadId) ?? 'stop' }
            : chunk.outcome
        setMessageTurnOutcome(store, threadId, st.msgId, outcome)
        if (outcome.status === 'failed' && outcome.error) {
          // A no-op for ordinary threads; for an automation run it is what Activity and
          // the manager read to say why an unattended run died.
          const detail = outcome.error
          markAutomationRunFailed(store, threadId, {
            code: classifyAutomationFailureMessage(
              `${detail.message} ${detail.code === undefined ? '' : String(detail.code)}`,
            ),
            message: detail.message.slice(0, 500),
          })
        }
        break
      }
      case 'done': {
        if (st.msgId) store.emit('message_done', st.msgId)
        state.delete(threadId)
        // The turn is over; the next one resolves its own parameters (or none).
        pendingTurn.delete(threadId)
        hooks.beforeIdle?.(threadId)
        setThreadStatus(store, threadId, 'idle')
        hooks.turnDone?.(threadId)
        break
      }
    }
  }

  return {
    apply,
    streamingMessageId: (threadId) => state.get(threadId)?.msgId ?? null,
    checkpoint: (threadId): TranscriptCheckpoint =>
      structuredClone({
        stream: state.get(threadId) ?? null,
        pendingTurn: pendingTurn.get(threadId) ?? null,
      }),
    restore: (threadId, checkpoint): void => {
      state.delete(threadId)
      pendingTurn.delete(threadId)
      if (checkpoint.stream) state.set(threadId, structuredClone(checkpoint.stream))
      if (checkpoint.pendingTurn) pendingTurn.set(threadId, structuredClone(checkpoint.pendingTurn))
    },
  }
}
