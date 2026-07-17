import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { Message, QueuedUserMessage, Thread, UserContent } from '@shared/types'
import type { QueuedMessageOrigin } from '@shared/types/thread.ts'
import {
  addMessage,
  clearContextSnapshot,
  setMessageContent,
  setQueuePaused,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'

/**
 * A **held** queued message (decisions 5 & 16): `autoDispatch: false` means the
 * drain loop must skip it — it never auto-submits at idle; only an explicit human
 * action (release / send-now) dispatches it. Absent/other means a normal
 * auto-draining item.
 */
export function isHeldMessage(item: QueuedUserMessage): boolean {
  return item.autoDispatch === false
}

/**
 * Whether a hook output's epoch is **stale** relative to the thread's current
 * turn tree (decision 16). An output from a non-current epoch must never abort or
 * auto-submit — its send-now downgrades to held. A message with no epoch (a
 * human-authored item) is never stale; a thread with no recorded current epoch
 * has no newer turn tree to be stale against, so nothing is stale yet.
 */
export function isStaleEpoch(thread: Pick<Thread, 'currentEpoch'>, epoch: string): boolean {
  return thread.currentEpoch !== undefined && thread.currentEpoch !== epoch
}

/** Mint a fresh turn-tree epoch for a human-initiated submission (decision 16). */
function newEpoch(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Start a fresh turn tree for a human-initiated submission (decision 16): record
 * a new `currentEpoch` on the thread so any in-flight async hook carrying an
 * older epoch is recognised as **stale** when its output lands. Called at the
 * human entry points (a typed prompt that dispatches, a held-message release);
 * the authoritative turn-tree ledger that keeps this in lock-step with the main
 * process's dispatch epoch is C3. Returns the new epoch.
 */
export function startHumanTurnTree(store: AppStore, threadId: string): string {
  const epoch = newEpoch()
  const threads = store
    .getState()
    .threads.map((t) => (t.id !== threadId ? t : { ...t, currentEpoch: epoch }))
  store.setState({ threads })
  return epoch
}

function refreshPayload(
  store: AppStore,
  threadId: string,
  payload: AgentRunPayload,
): AgentRunPayload {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  return {
    ...payload,
    priorTodos: thread?.todos ?? payload.priorTodos ?? [],
    ...(thread?.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
    // Send the per-thread model so the run uses the picker's selection rather
    // than the global default. Read at dispatch time so a change made while the
    // message was queued still takes effect. Absent → main uses the global default.
    ...(thread?.model !== undefined ? { model: thread.model } : {}),
  }
}

export function dispatchAgentRun(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  payload: AgentRunPayload,
): void {
  clearContextSnapshot(store, threadId)
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.run(threadId, JSON.stringify(refreshPayload(store, threadId, payload)))
}

export function enqueueUserMessage(
  store: AppStore,
  threadId: string,
  item: QueuedUserMessage,
): void {
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          pendingMessages: [...(t.pendingMessages ?? []), item],
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  store.emit('message_queued', threadId, item.messageId)
  store.emit('threads_changed')
}

export function drainMessageQueue(store: AppStore, api: ApiClient, threadId: string): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread || thread.status !== 'idle' || thread.queuePaused) return
  const pending = thread.pendingMessages ?? []
  if (pending.length === 0) return

  // Held items (decision 5): `drainMessageQueue` skips them entirely — a held
  // message never auto-submits at idle; only an explicit human action dispatches
  // it. Drain the first *auto-dispatching* item and leave every held item queued
  // (still shown in the pinned panel with a release action). A queue of only
  // held items drains nothing.
  const next = pending.find((item) => !isHeldMessage(item))
  if (!next) return
  const rest = pending.filter((item) => item !== next)
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...restThread } = t
    const messages = movePendingUserMessagesToEnd(t.messages, pending)
    return rest.length > 0
      ? { ...restThread, messages, pendingMessages: rest, updatedAt: Date.now() }
      : { ...restThread, messages, updatedAt: Date.now() }
  })
  store.setState({ threads })
  store.emit('threads_changed')
  dispatchAgentRun(store, api, threadId, next.payload)
}

export function movePendingUserMessagesToEnd(
  messages: Message[],
  pending: QueuedUserMessage[],
): Message[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  const pendingMessages: Message[] = []
  const movedIds = new Set<string>()
  for (const item of pending) {
    const message = messagesById.get(item.messageId)
    if (!message || message.role !== 'user' || movedIds.has(message.id)) continue
    pendingMessages.push(message)
    movedIds.add(message.id)
  }
  if (pendingMessages.length === 0) return messages

  const settledMessages = messages.filter((message) => !movedIds.has(message.id))
  const nextMessages = [...settledMessages, ...pendingMessages]
  const alreadyInOrder = nextMessages.every((message, index) => message === messages[index])
  return alreadyInOrder ? messages : nextMessages
}

export function resumePendingQueues(store: AppStore, api: ApiClient): void {
  for (const thread of store.getState().threads) {
    // A fresh session has no open inline editors, so a persisted pause is stale.
    if (thread.queuePaused) setQueuePaused(store, thread.id, false)
    // A crash mid-run can leave status stuck at running with no live main-process run.
    let status = thread.status
    if (status === 'running') {
      setThreadStatus(store, thread.id, 'idle')
      status = 'idle'
    }
    if (status === 'idle' && (thread.pendingMessages?.length ?? 0) > 0) {
      drainMessageQueue(store, api, thread.id)
    }
  }
}

export function queuedMessageIds(thread: { pendingMessages?: QueuedUserMessage[] }): Set<string> {
  return new Set((thread.pendingMessages ?? []).map((item) => item.messageId))
}

/** The user-authored text portion of a queued payload (the editable bit). */
export function queuedPayloadText(payload: AgentRunPayload): string {
  const content = payload.content
  if (typeof content === 'string') return content
  return content.find((block) => block.type === 'text')?.text ?? ''
}

function withPayloadText(content: UserContent, text: string): UserContent {
  if (typeof content === 'string') return text
  let replaced = false
  const next = content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { ...block, text }
  })
  // `replaced` is mutated inside the .map callback above, which ESLint's
  // control-flow analysis cannot track, so it wrongly flags this as falsy.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return replaced ? next : [...next, { type: 'text' as const, text }]
}

/**
 * Persist an inline edit to a queued message: updates both the run payload (what
 * the agent receives) and the displayed bubble text.
 */
export function updateQueuedMessageText(
  store: AppStore,
  threadId: string,
  messageId: string,
  text: string,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const item = thread?.pendingMessages?.find((p) => p.messageId === messageId)
  if (!item) return
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          pendingMessages: (t.pendingMessages ?? []).map((p) =>
            p.messageId !== messageId
              ? p
              : {
                  ...p,
                  payload: { ...p.payload, content: withPayloadText(p.payload.content, text) },
                  // Editing a hook-originated message keeps `kind: 'hook'` but
                  // flips `editedByUser` so the spine stays honest (decision 10).
                  ...(p.origin?.kind === 'hook' ? { editedByUser: true } : {}),
                },
          ),
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  setMessageContent(store, messageId, text)
  store.emit('threads_changed')
}

/**
 * Run a queued message immediately: move it to the front of the queue, lift any
 * editing pause, then abort the active run. The trailing `done` chunk triggers
 * the normal FIFO drain, which now dispatches this message first.
 */
/** Drop a queued follow-up from the FIFO list and remove its user bubble. */
export function removeQueuedMessage(store: AppStore, threadId: string, messageId: string): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  const pending = thread.pendingMessages ?? []
  if (!pending.some((p) => p.messageId === messageId)) return

  const remainingPending = pending.filter((p) => p.messageId !== messageId)
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...rest } = t
    return {
      ...rest,
      messages: t.messages.filter((m) => m.id !== messageId),
      ...(remainingPending.length > 0 ? { pendingMessages: remainingPending } : {}),
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads })
  store.emit('threads_changed')
}

export function sendQueuedMessageNow(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  messageId: string,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const pending = thread?.pendingMessages ?? []
  const target = pending.find((p) => p.messageId === messageId)
  if (!thread || !target) return

  const reordered = [target, ...pending.filter((p) => p.messageId !== messageId)]
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { queuePaused: _removed, ...rest } = t
    return { ...rest, pendingMessages: reordered, updatedAt: Date.now() }
  })
  store.setState({ threads })
  store.emit('threads_changed')

  if (thread.status === 'running') {
    // Remote agents run on the provider's servers, where aborting cancels the live
    // run ("Agent already has an active run" on the next turn). Leave the reordered
    // message queued — it drains onto the same remote agent once this run finishes,
    // so a follow-up never kills the agent. Local runs interrupt as before.
    const model = thread.model ?? store.getState().settings?.model ?? ''
    if (isRemoteAgentModel(model)) return
    // Abort the live run; its `done` chunk drains the reordered queue head.
    void api.agent.abort(threadId)
  } else {
    drainMessageQueue(store, api, threadId)
  }
}

/** An async hook's `queueMessage` output, bridged from the host (decision 4). */
export interface HookQueueMessageInput {
  /** The hook-authored message text. */
  text: string
  /** Provenance: the hook + event that produced it (decision 10). */
  origin: QueuedMessageOrigin
  /** Emitting turn-tree epoch (decision 16); checked for staleness on arrival. */
  epoch: string
  /** Whether the hook requested immediate send (decision 4). */
  sendNow: boolean
}

/**
 * Land an async hook's `queueMessage` in the thread's pending queue — the only
 * async output channel (decision 4). The message renders as a `user` bubble with
 * hook provenance (decision 10) and full edit / delete / send-now affordances.
 *
 * **Staleness is checked before the send-now abort path (decision 16).** A hook
 * output from a non-current turn tree (`epoch` mismatch) must never abort or
 * auto-submit into a newer, unrelated human turn:
 *   - **stale** → enqueued **held** (`autoDispatch: false`): the drain loop skips
 *     it and `sendNow` is ignored (no abort), so it waits for an explicit human
 *     release. Never a plain enqueue — a plain item would auto-drain at idle,
 *     re-opening the back door (decision 16, known trap).
 *   - **current + `sendNow`** → the normal send-now path (may abort a local run).
 *   - **current, no `sendNow`** → a plain queued item that auto-drains at idle.
 */
export function enqueueHookMessage(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  input: HookQueueMessageInput,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) return

  // Create the user bubble the queue view renders; `origin` keeps it attributable.
  const messageId = addMessage(store, threadId, 'user', input.text)
  const stale = isStaleEpoch(thread, input.epoch)
  const item: QueuedUserMessage = {
    messageId,
    payload: { content: input.text },
    createdAt: Date.now(),
    origin: input.origin,
    epoch: input.epoch,
    // Downgrade a stale send-now to held (decision 16) — decided *before* any
    // send-now abort path is reached below.
    ...(stale ? { autoDispatch: false as const } : {}),
  }
  enqueueUserMessage(store, threadId, item)

  if (stale) return // held: no send-now, no abort, no auto-drain — waits for a human.
  if (input.sendNow) sendQueuedMessageNow(store, api, threadId, messageId)
  else drainMessageQueue(store, api, threadId)
}

/**
 * Release a **held** queued message (decisions 5 & 16): an explicit human action
 * that clears the hold and submits it, starting a **fresh turn tree** (new
 * `currentEpoch`) with a reset budget — C3 owns the budget-ledger reset; C2
 * clears the hold, mints the new epoch, and dispatches. Reuses the send-now path
 * so a release while the agent runs interrupts like any human send-now, and a
 * release at idle drains immediately.
 */
export function releaseHeldMessage(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  messageId: string,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const item = thread?.pendingMessages?.find((p) => p.messageId === messageId)
  if (!thread || !item) return

  const epoch = newEpoch()
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    return {
      ...t,
      currentEpoch: epoch,
      pendingMessages: (t.pendingMessages ?? []).map((p) => {
        if (p.messageId !== messageId) return p
        // Clear the hold so the item can dispatch (and auto-drain if left queued).
        const { autoDispatch: _released, ...rest } = p
        return rest
      }),
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads })
  store.emit('threads_changed')
  sendQueuedMessageNow(store, api, threadId, messageId)
}
