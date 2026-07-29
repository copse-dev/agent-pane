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
import { canContinue, DEFAULT_CONTINUATION_BUDGET } from '@copse/agent/hooks/continuation-budget.ts'

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
 * Whether a queued message is a **machine-initiated** continuation (decision 5):
 * a hook-originated item (hook send-now, `stop` / `subagentStop` follow-ups).
 * Only these consume the auto-continuation budget at drain time — human-authored
 * queued messages never do.
 */
export function isMachineContinuation(item: QueuedUserMessage): boolean {
  return item.origin?.kind === 'hook'
}

/**
 * Visible thread note shown when a machine follow-up is held because the turn
 * tree's auto-continuation budget is exhausted (decision 5). Explains why it did
 * not auto-submit and that a human release resumes it (starting a fresh budget).
 */
export function continuationBudgetHeldNote(): string {
  return `Auto-continuation budget reached — ${String(DEFAULT_CONTINUATION_BUDGET)} machine-initiated follow-ups have run in this turn. The next hook follow-up is held; release it to continue (that starts a fresh turn with a reset budget).`
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
  return startRootTurnTree(store, threadId)
}

/**
 * Start a fresh root turn for a scheduled automation. A schedule is its own
 * user-authorized root (not a continuation of another chat), so it receives a
 * new epoch and the normal full continuation budget.
 */
export function startAutomationTurnTree(store: AppStore, threadId: string): string {
  return startRootTurnTree(store, threadId)
}

function startRootTurnTree(store: AppStore, threadId: string): string {
  const epoch = newEpoch()
  const threads = store
    .getState()
    // A fresh turn tree resets the auto-continuation budget (decision 5): a
    // user-authorized root is the floor, and the machine-turn counter starts
    // over.
    .threads.map((t) =>
      t.id !== threadId ? t : { ...t, currentEpoch: epoch, continuationUsed: 0 },
    )
  store.setState({ threads })
  return epoch
}

/**
 * Fold a finished run's in-process machine-turn spend back onto the thread's
 * per-turn-tree counter (C3 run→drain direction, decision 5 / E3). The run seeds
 * the main-process ledger from `Thread.continuationUsed` (drain→run) and spends
 * against it as its in-run tighteners (todo closeout / pre-review gate /
 * remediation) run; this closes the loop so the renderer's *next* queue drain
 * sees that spend and still enforces the shared cap.
 *
 * Guarded on the turn-tree epoch (decision 16): a human action since the run
 * started (typed prompt / send-now / release) mints a fresh `currentEpoch` and
 * resets the budget, so a fold-back from the *old* turn tree must be dropped —
 * never clobber the reset. The counter only moves up (monotonic within a turn
 * tree, matching the ledger's `seed`).
 *
 * A thread that never minted an epoch (no `currentEpoch`) still folds back:
 * the run keyed its ledger by the thread id (the main-process fallback), so a
 * fold-back carrying `turnTreeId === threadId` is this thread's own spend, not
 * a stale one — dropping it would undercount and let the next run exceed the
 * cap. A human reset always mints an epoch, so once `currentEpoch` exists the
 * thread-id fallback no longer matches and genuinely stale reports still drop.
 */
export function foldBackContinuationUsed(
  store: AppStore,
  threadId: string,
  turnTreeId: string,
  used: number,
): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  const currentKey = thread.currentEpoch ?? threadId
  if (currentKey !== turnTreeId) return
  const next = Math.max(thread.continuationUsed ?? 0, used)
  if (next === (thread.continuationUsed ?? 0)) return
  const threads = store
    .getState()
    .threads.map((t) => (t.id !== threadId ? t : { ...t, continuationUsed: next }))
  store.setState({ threads })
}

/**
 * Stamp hook provenance (decision 10) onto a message so a hook-originated turn
 * stays marked once it dispatches (leaving the pending queue) and — via the
 * spine — after a reload. Keeps the message role `user` for the LLM.
 */
function setMessageHookOrigin(
  store: AppStore,
  messageId: string,
  origin: QueuedMessageOrigin,
): void {
  const threads = store.getState().threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, origin })),
  }))
  store.setState({ threads })
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
    // C3: thread the turn-tree epoch + the machine turns already spent so the
    // main-process continuation ledger keys and seeds the same counter this
    // renderer enforces at drain time (decision 5 / 16). Read at dispatch time so
    // a queue-drain continuation carries the up-to-date spent count.
    ...(thread?.currentEpoch !== undefined ? { turnTreeId: thread.currentEpoch } : {}),
    ...(thread?.continuationUsed !== undefined
      ? { continuationBudgetUsed: thread.continuationUsed }
      : {}),
  }
}

export function dispatchAgentRun(
  store: AppStore,
  api: { agent: Pick<ApiClient['agent'], 'run'> },
  threadId: string,
  payload: AgentRunPayload,
): void {
  const projectId = store.getState().activeProjectId
  if (!projectId) throw new Error('Cannot run thread without an active project')
  clearContextSnapshot(store, threadId)
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.run(projectId, threadId, JSON.stringify(refreshPayload(store, threadId, payload)))
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
  // it. A queue of only held items drains nothing.
  //
  // Auto-continuation budget (decision 5): a machine-initiated continuation (a
  // hook-originated item) consumes one unit of the turn tree's budget when it
  // *drains* — checked here, not at enqueue. Over budget, the item flips to
  // **held** (`autoDispatch: false`) with a visible thread note; the drain then
  // continues past it, so a human-authored item behind an over-budget machine
  // item still submits. Human-authored items never consume budget.
  let used = thread.continuationUsed ?? 0
  let next: QueuedUserMessage | undefined
  const heldByBudget: string[] = []
  for (const item of pending) {
    if (isHeldMessage(item)) continue
    if (isMachineContinuation(item)) {
      if (!canContinue(used)) {
        heldByBudget.push(item.messageId)
        continue
      }
      used += 1
      next = item
      break
    }
    next = item
    break
  }

  if (!next && heldByBudget.length === 0) return

  const rest = pending.filter((item) => item !== next)
  const budgetHeld = new Set(heldByBudget)
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { pendingMessages: _removed, ...restThread } = t
    const messages = movePendingUserMessagesToEnd(t.messages, pending)
    // Flip over-budget machine items to held so the pinned panel offers Release.
    const nextPending = rest.map((item) =>
      budgetHeld.has(item.messageId) ? { ...item, autoDispatch: false as const } : item,
    )
    const base =
      nextPending.length > 0
        ? { ...restThread, messages, pendingMessages: nextPending, updatedAt: Date.now() }
        : { ...restThread, messages, updatedAt: Date.now() }
    // Record the machine turn we are about to dispatch so the next drain (and the
    // run payload's seed) reflect it (decision 5).
    return next && isMachineContinuation(next) ? { ...base, continuationUsed: used } : base
  })
  store.setState({ threads })

  // One visible note when the budget forced items to held (decision 5).
  if (heldByBudget.length > 0) addMessage(store, threadId, 'error', continuationBudgetHeldNote())

  store.emit('threads_changed')
  if (next) dispatchAgentRun(store, api, threadId, next.payload)
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
  // Keep the message honest: editing a hook-originated message flips
  // `editedByUser` on the bubble too (decision 10), matching the queued item.
  if (item.origin?.kind === 'hook') {
    const withEdit = store.getState().threads.map((t) => ({
      ...t,
      messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, editedByUser: true })),
    }))
    store.setState({ threads: withEdit })
  }
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
    // Abort the live run (local or remote); its `done` chunk drains the reordered
    // queue head. Remote follow-up create retries on `409 agent_busy` until the
    // cancelled run settles — see `createRemoteRun` in remote-agent-client.ts.
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

  // Create the user bubble the queue view renders; `origin` keeps it attributable
  // (decision 10) — stamped on the Message too so a hook-originated turn stays
  // marked once it dispatches and leaves the pending queue (and after a reload,
  // via the spine). The message role stays `user` for the LLM.
  const messageId = addMessage(store, threadId, 'user', input.text)
  setMessageHookOrigin(store, messageId, input.origin)
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
 * `currentEpoch`) with a reset budget — C3 resets the machine-turn counter here
 * (`continuationUsed: 0`) as it clears the hold, mints the new epoch, and
 * dispatches. Reuses the send-now path so a release while the agent runs
 * interrupts like any human send-now, and a release at idle drains immediately.
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
      // A human release starts a fresh turn tree with a reset budget (decision 5).
      continuationUsed: 0,
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
