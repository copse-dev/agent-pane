import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import { at } from '@shared/array-utils.ts'
import {
  addMessage,
  createThread,
  setQueuePaused,
  setThreadStatus,
  setThreadTodos,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  continuationBudgetHeldNote,
  dispatchAgentRun,
  drainMessageQueue,
  enqueueHookMessage,
  enqueueUserMessage,
  foldBackContinuationUsed,
  isHeldMessage,
  isStaleEpoch,
  movePendingUserMessagesToEnd,
  queuedMessageIds,
  queuedPayloadText,
  releaseHeldMessage,
  removeQueuedMessage,
  resumePendingQueues,
  sendQueuedMessageNow,
  startHumanTurnTree,
  updateQueuedMessageText,
} from './message-queue.ts'
import { DEFAULT_CONTINUATION_BUDGET } from '@copse/agent/hooks/continuation-budget.ts'
import type { QueuedMessageOrigin } from '@shared/types/thread.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

const HOOK_ORIGIN: QueuedMessageOrigin = { kind: 'hook', hookId: 'todo-closeout', event: 'stop' }

function createProjectStore(): ReturnType<typeof createStore> {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  return store
}

/** Set the thread's current turn-tree epoch (decision 16 reference point). */
function setCurrentEpoch(
  store: ReturnType<typeof createStore>,
  threadId: string,
  epoch: string,
): void {
  store.setState({
    threads: store
      .getState()
      .threads.map((t) => (t.id !== threadId ? t : { ...t, currentEpoch: epoch })),
  })
}

function fakeApi(): ApiClient & {
  runs: Array<[string, string]>
  projectIds: string[]
  aborts: string[]
  runningThreadIds: string[]
} {
  const runs: Array<[string, string]> = []
  const projectIds: string[] = []
  const aborts: string[] = []
  // Mutate this before calling resumePendingQueues to simulate a thread with a
  // genuinely still-live main-process run (#1406) — defaults to none, matching
  // "no live run survived" for tests that don't care about that distinction.
  const runningThreadIds: string[] = []
  return ((): ApiClient & {
    runs: Array<[string, string]>
    projectIds: string[]
    aborts: string[]
    runningThreadIds: string[]
  } => {
    const base = createFakeApi()
    return {
      ...base,
      runs,
      projectIds,
      aborts,
      runningThreadIds,
      agent: {
        ...base['agent'],
        run: (projectId: string, threadId: string, payload: string): Promise<void> => {
          projectIds.push(projectId)
          runs.push([threadId, payload])
          return Promise.resolve()
        },
        abort: (threadId: string): Promise<void> => {
          aborts.push(threadId)
          return Promise.resolve()
        },
        runningThreadIds: (): Promise<string[]> => Promise.resolve(runningThreadIds),
      },
    } satisfies ApiClient & {
      runs: Array<[string, string]>
      projectIds: string[]
      aborts: string[]
      runningThreadIds: string[]
    }
  })()
}

function getThread(store: ReturnType<typeof createStore>, threadId: string): Thread {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  return thread
}

function firstRun(api: { runs: Array<[string, string]> }): [string, string] {
  const run = api.runs[0]
  if (!run) throw new Error('expected at least one agent run')
  return run
}

test('enqueueUserMessage appends to thread.pendingMessages and emits message_queued', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const queued: string[] = []
  store.on('message_queued', (_tid, messageId) => queued.push(messageId))

  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'follow up' },
    createdAt: 1,
  })

  const thread = getThread(store, threadId)
  const pending = thread.pendingMessages ?? []
  assert.equal(pending.length, 1)
  assert.equal(at(pending, 0).messageId, 'msg-1')
  assert.deepEqual(queued, ['msg-1'])
  assert.equal(api.runs.length, 0)
})

test('drainMessageQueue dispatches the next payload when idle', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'queued prompt', priorTodos: [] },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  const thread = getThread(store, threadId)
  assert.equal(thread.status, 'running')
  assert.equal(thread.pendingMessages, undefined)
  assert.equal(api.runs.length, 1)
  const run = firstRun(api)
  assert.equal(run[0], threadId)
  assert.match(run[1], /queued prompt/)
})

test('drainMessageQueue moves pending user messages after the completed turn', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const firstMessageId = addMessage(store, threadId, 'user', 'first prompt')
  const queuedMessageId = addMessage(store, threadId, 'user', 'queued follow up')
  const assistantMessageId = addMessage(store, threadId, 'assistant', 'first response')
  enqueueUserMessage(store, threadId, {
    messageId: queuedMessageId,
    payload: { content: 'queued follow up' },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    [firstMessageId, assistantMessageId, queuedMessageId],
  )
})

test('movePendingUserMessagesToEnd preserves queued FIFO order', () => {
  const messages: Message[] = [
    { id: 'user-1', role: 'user', content: 'first', toolCalls: [], createdAt: 1 },
    { id: 'queued-1', role: 'user', content: 'queued 1', toolCalls: [], createdAt: 2 },
    { id: 'queued-2', role: 'user', content: 'queued 2', toolCalls: [], createdAt: 3 },
    { id: 'assistant-1', role: 'assistant', content: 'response', toolCalls: [], createdAt: 4 },
  ]

  const reordered = movePendingUserMessagesToEnd(
    [...messages],
    [
      { messageId: 'queued-1', payload: { content: 'queued 1' }, createdAt: 2 },
      { messageId: 'queued-2', payload: { content: 'queued 2' }, createdAt: 3 },
    ],
  )

  assert.deepEqual(
    reordered.map((message) => message.id),
    ['user-1', 'assistant-1', 'queued-1', 'queued-2'],
  )
})

test('drainMessageQueue refreshes priorTodos from the live thread state', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'next', priorTodos: [{ id: 'old', content: 'old', status: 'pending' }] },
    createdAt: 1,
  })
  setThreadTodos(store, threadId, [{ id: 'live', content: 'live', status: 'pending' }])

  drainMessageQueue(store, api, threadId)

  const payload = expectRecord(parseJsonUnknown(firstRun(api)[1]))
  assert.deepEqual(payload['priorTodos'], [{ id: 'live', content: 'live', status: 'pending' }])
})

test('dispatchAgentRun sends the per-thread model so the run honours the picker', () => {
  const store = createStore({ settings: { model: 'claude-opus-4-8' } })
  store.setState({ activeProjectId: 'project-1' })
  const api = fakeApi()
  const threadId = createThread(store) // seeds thread.model from the global default

  dispatchAgentRun(store, api, threadId, { content: 'go' })

  const payload = expectRecord(parseJsonUnknown(firstRun(api)[1]))
  assert.equal(payload['model'], 'claude-opus-4-8')
})

test('dispatchAgentRun omits model when the thread has none, so main uses the global default', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store) // no global default → thread.model absent

  dispatchAgentRun(store, api, threadId, { content: 'go' })

  const payload = expectRecord(parseJsonUnknown(firstRun(api)[1]))
  assert.equal('model' in payload, false)
})

test('drainMessageQueue does nothing while the thread is running', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'wait' },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.pendingMessages?.length, 1)
})

test('dispatchAgentRun marks the thread running and sends payload', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)

  dispatchAgentRun(store, api, threadId, { content: 'go' })

  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.status, 'running')
  assert.equal(api.runs.length, 1)
})

test('resumePendingQueues drains idle threads with pending messages', async () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'resume me' },
    createdAt: 1,
  })

  await resumePendingQueues(store, api)

  assert.equal(api.runs.length, 1)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.status, 'running')
})

test('queuedMessageIds returns pending message ids', () => {
  const thread = {
    pendingMessages: [
      { messageId: 'a', payload: { content: '1' }, createdAt: 1 },
      { messageId: 'b', payload: { content: '2' }, createdAt: 2 },
    ],
  }
  assert.deepEqual([...queuedMessageIds(thread)].sort(), ['a', 'b'])
})

test('queuedPayloadText extracts text from string and array payloads', () => {
  assert.equal(queuedPayloadText({ content: 'plain' }), 'plain')
  assert.equal(
    queuedPayloadText({
      content: [
        { type: 'image', dataUrl: 'data:img' },
        { type: 'text', text: 'with image' },
      ],
    }),
    'with image',
  )
})

test('drainMessageQueue does nothing while the queue is paused', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'paused' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.pendingMessages?.length, 1)
})

test('updateQueuedMessageText edits the payload text and the displayed bubble', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'original')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'original', invokedSkills: [] },
    createdAt: 1,
  })

  updateQueuedMessageText(store, threadId, messageId, 'edited prompt')

  const thread = getThread(store, threadId)
  assert.equal(thread.pendingMessages?.[0]?.payload.content, 'edited prompt')
  assert.equal(thread.messages.find((m) => m.id === messageId)?.content, 'edited prompt')
})

test('removeQueuedMessage drops the pending entry and user bubble', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const firstMessageId = addMessage(store, threadId, 'user', 'first prompt')
  const queuedMessageId = addMessage(store, threadId, 'user', 'queued follow up')
  enqueueUserMessage(store, threadId, {
    messageId: queuedMessageId,
    payload: { content: 'queued follow up' },
    createdAt: 1,
  })

  removeQueuedMessage(store, threadId, queuedMessageId)

  const thread = getThread(store, threadId)
  assert.equal(thread.pendingMessages, undefined)
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    [firstMessageId],
  )
})

test('removeQueuedMessage is a no-op for a message that is not queued', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'sent prompt')

  removeQueuedMessage(store, threadId, messageId)

  const thread = getThread(store, threadId)
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.pendingMessages, undefined)
})

test('removeQueuedMessage keeps remaining queued messages in order', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const firstQueuedId = addMessage(store, threadId, 'user', 'first queued')
  const secondQueuedId = addMessage(store, threadId, 'user', 'second queued')
  enqueueUserMessage(store, threadId, {
    messageId: firstQueuedId,
    payload: { content: 'first queued' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: secondQueuedId,
    payload: { content: 'second queued' },
    createdAt: 2,
  })

  removeQueuedMessage(store, threadId, firstQueuedId)

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((item) => item.messageId),
    [secondQueuedId],
  )
  assert.equal(
    thread.messages.some((message) => message.id === firstQueuedId),
    false,
  )
  assert.equal(
    thread.messages.some((message) => message.id === secondQueuedId),
    true,
  )
})

test('updateQueuedMessageText preserves images when editing an array payload', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'original')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: {
      content: [
        { type: 'image', dataUrl: 'data:img' },
        { type: 'text', text: 'original' },
      ],
    },
    createdAt: 1,
  })

  updateQueuedMessageText(store, threadId, messageId, 'edited')

  const content = getThread(store, threadId).pendingMessages?.[0]?.payload.content
  assert.deepEqual(content, [
    { type: 'image', dataUrl: 'data:img' },
    { type: 'text', text: 'edited' },
  ])
})

test('sendQueuedMessageNow reorders to the front and aborts the running thread', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'first',
    payload: { content: 'first' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: 'second',
    payload: { content: 'second' },
    createdAt: 2,
  })

  sendQueuedMessageNow(store, api, threadId, 'second')

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    ['second', 'first'],
  )
  assert.deepEqual(api.aborts, [threadId])
  assert.equal(api.runs.length, 0)
})

test('sendQueuedMessageNow aborts a running remote agent so the follow-up can drain', () => {
  const store = createStore({ settings: { model: 'remote-agent:cursor' } })
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'first',
    payload: { content: 'first' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: 'second',
    payload: { content: 'second' },
    createdAt: 2,
  })

  sendQueuedMessageNow(store, api, threadId, 'second')

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    ['second', 'first'],
  )
  // Same interrupt path as local: abort → done → drain. Remote create retries
  // briefly on 409 agent_busy while the cancelled run settles.
  assert.deepEqual(api.aborts, [threadId])
  assert.equal(api.runs.length, 0)
})

test('sendQueuedMessageNow lifts pause and drains immediately when idle', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'go now' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  sendQueuedMessageNow(store, api, threadId, 'msg-1')

  const thread = getThread(store, threadId)
  assert.equal(thread.queuePaused, undefined)
  assert.equal(thread.status, 'running')
  assert.equal(api.runs.length, 1)
  assert.deepEqual(api.projectIds, ['project-1'])
  assert.match(firstRun(api)[1], /go now/)
})

test('resumePendingQueues clears a stale pause then drains', async () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'resume me' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  await resumePendingQueues(store, api)

  const thread = getThread(store, threadId)
  assert.equal(thread.queuePaused, undefined)
  assert.equal(api.runs.length, 1)
})

test('resumePendingQueues resets a stale running status when the queue is empty', async () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')

  await resumePendingQueues(store, api)

  const thread = getThread(store, threadId)
  assert.equal(thread.status, 'idle')
  assert.equal(api.runs.length, 0)
})

test('resumePendingQueues (#1406): leaves status alone when the main process confirms the run is still live', async () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  api.runningThreadIds.push(threadId)

  await resumePendingQueues(store, api)

  const thread = getThread(store, threadId)
  assert.equal(thread.status, 'running', 'a genuinely still-running thread keeps its stop control')
  assert.equal(api.runs.length, 0)
})

test('resumePendingQueues (#1406): still resets a different thread whose run is not in the live set', async () => {
  const store = createProjectStore()
  const api = fakeApi()
  const liveId = createThread(store)
  const staleId = createThread(store)
  setThreadStatus(store, liveId, 'running')
  setThreadStatus(store, staleId, 'running')
  api.runningThreadIds.push(liveId)

  await resumePendingQueues(store, api)

  assert.equal(getThread(store, liveId).status, 'running')
  assert.equal(getThread(store, staleId).status, 'idle')
})

// --- C2 contract tests ------------------------------------------------------
// Named for the decisions they pin (execution-guidance rule 2), house style of
// permission-platform.test.ts. See docs/plans/hooks-and-feature-packs.md.

test('held-items-never-drain (decision 5): drainMessageQueue skips a held item at idle', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'held follow-up')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'held follow-up' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'e1',
    autoDispatch: false,
  })

  // Thread is idle — a plain queued item would auto-submit here. A held one must not.
  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0, 'a held item must never auto-drain')
  const thread = getThread(store, threadId)
  assert.equal(thread.pendingMessages?.length, 1, 'the held item stays queued')
  assert.equal(isHeldMessage(at(thread.pendingMessages ?? [], 0)), true)
})

test('held-items-never-drain (decision 5): drain skips the held head and dispatches the next plain item', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const heldId = addMessage(store, threadId, 'user', 'held')
  const plainId = addMessage(store, threadId, 'user', 'plain')
  enqueueUserMessage(store, threadId, {
    messageId: heldId,
    payload: { content: 'held' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'e1',
    autoDispatch: false,
  })
  enqueueUserMessage(store, threadId, {
    messageId: plainId,
    payload: { content: 'plain' },
    createdAt: 2,
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 1, 'the plain item drains past the held head')
  assert.match(firstRun(api)[1], /plain/)
  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    [heldId],
    'the held item remains queued after the plain item drains',
  )
})

test('stale-epoch-never-aborts (decision 16): a stale hook send-now downgrades to held, no abort', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  setCurrentEpoch(store, threadId, 'epoch-current')

  // A late async hook from a *completed* turn tree requests send-now.
  enqueueHookMessage(store, api, threadId, {
    text: 'late hook output',
    origin: HOOK_ORIGIN,
    epoch: 'epoch-stale',
    sendNow: true,
  })

  assert.deepEqual(api.aborts, [], 'a stale send-now must never abort the active run')
  assert.equal(api.runs.length, 0)
  const thread = getThread(store, threadId)
  const item = at(thread.pendingMessages ?? [], 0)
  assert.equal(isHeldMessage(item), true, 'the stale send-now is held, not plain-queued')
  assert.equal(item.origin?.kind, 'hook')
  assert.equal(item.epoch, 'epoch-stale')

  // And being held, it does not auto-drain when the run finishes.
  setThreadStatus(store, threadId, 'idle')
  drainMessageQueue(store, api, threadId)
  assert.equal(api.runs.length, 0, 'the downgraded item never auto-submits')
})

test('stale-epoch-never-aborts (decision 16): a current-epoch hook send-now takes the abort path', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  setCurrentEpoch(store, threadId, 'epoch-current')

  enqueueHookMessage(store, api, threadId, {
    text: 'current hook output',
    origin: HOOK_ORIGIN,
    epoch: 'epoch-current',
    sendNow: true,
  })

  assert.deepEqual(api.aborts, [threadId], 'a current-epoch send-now aborts the live local run')
  const thread = getThread(store, threadId)
  assert.equal(
    isHeldMessage(at(thread.pendingMessages ?? [], 0)),
    false,
    'current item is not held',
  )
})

test('isStaleEpoch: no current epoch (no newer turn tree) is never stale; a differing epoch is', () => {
  assert.equal(isStaleEpoch({}, 'e1'), false)
  assert.equal(isStaleEpoch({ currentEpoch: 'e1' }, 'e1'), false)
  assert.equal(isStaleEpoch({ currentEpoch: 'e2' }, 'e1'), true)
})

test('enqueueHookMessage: origin attribution lands on the queued message (decision 10)', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')

  // No current epoch set → not stale; plain queued while running.
  enqueueHookMessage(store, api, threadId, {
    text: 'hook says hi',
    origin: HOOK_ORIGIN,
    epoch: 'e1',
    sendNow: false,
  })

  const item = at(getThread(store, threadId).pendingMessages ?? [], 0)
  assert.deepEqual(item.origin, HOOK_ORIGIN)
  assert.equal(item.editedByUser, undefined, 'unedited hook message has no editedByUser flag')
  assert.equal(item.epoch, 'e1')
})

test('updateQueuedMessageText: editing a hook message keeps origin + sets editedByUser (decision 10)', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueHookMessage(store, api, threadId, {
    text: 'hook draft',
    origin: HOOK_ORIGIN,
    epoch: 'e1',
    sendNow: false,
  })
  const messageId = at(getThread(store, threadId).pendingMessages ?? [], 0).messageId

  updateQueuedMessageText(store, threadId, messageId, 'human-edited text')

  const item = at(getThread(store, threadId).pendingMessages ?? [], 0)
  assert.deepEqual(item.origin, HOOK_ORIGIN, 'origin stays kind:hook after an edit')
  assert.equal(item.editedByUser, true)
  assert.equal(item.payload.content, 'human-edited text')
})

test('updateQueuedMessageText: editing a human message does not set editedByUser', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'original')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'original' },
    createdAt: 1,
  })

  updateQueuedMessageText(store, threadId, messageId, 'edited')

  const item = at(getThread(store, threadId).pendingMessages ?? [], 0)
  assert.equal(item.editedByUser, undefined)
  assert.equal(item.origin, undefined)
})

test('releaseHeldMessage: un-holds, starts a fresh turn tree, and dispatches at idle', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setCurrentEpoch(store, threadId, 'epoch-stale')
  const messageId = addMessage(store, threadId, 'user', 'held work')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'held work' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'epoch-stale',
    autoDispatch: false,
  })

  releaseHeldMessage(store, api, threadId, messageId)

  assert.equal(api.runs.length, 1, 'release dispatches the held item at idle')
  assert.match(firstRun(api)[1], /held work/)
  const thread = getThread(store, threadId)
  assert.notEqual(thread.currentEpoch, 'epoch-stale', 'release starts a fresh turn tree')
  assert.equal(thread.currentEpoch !== undefined, true)
})

test('startHumanTurnTree: records a fresh current epoch on the thread (decision 16)', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  assert.equal(getThread(store, threadId).currentEpoch, undefined)

  const epoch = startHumanTurnTree(store, threadId)

  assert.equal(getThread(store, threadId).currentEpoch, epoch)
  assert.equal(typeof epoch, 'string')
})

// --- C3 contract tests (unified auto-continuation budget) --------------------
// Decision 5: budget-ledger increments; a machine follow-up over budget flips to
// held; a human action resets the budget. See docs/plans/hooks-and-feature-packs.md.

/** Set the thread's spent machine-turn count (decision 5 reference point). */
function setContinuationUsed(
  store: ReturnType<typeof createStore>,
  threadId: string,
  used: number,
): void {
  store.setState({
    threads: store
      .getState()
      .threads.map((t) => (t.id !== threadId ? t : { ...t, continuationUsed: used })),
  })
}

test('budget-ledger increments (decision 5): a machine-originated drain consumes one budget unit', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'hook follow-up')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'hook follow-up' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'e1',
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 1, 'a hook follow-up under budget auto-drains')
  assert.equal(getThread(store, threadId).continuationUsed, 1, 'the machine turn is counted')
})

test('budget-ledger increments (decision 5): drain seeds the run payload with the spent count', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, 2)
  setCurrentEpoch(store, threadId, 'tree-1')
  const messageId = addMessage(store, threadId, 'user', 'hook follow-up')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'hook follow-up' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'tree-1',
  })

  drainMessageQueue(store, api, threadId)

  const payload = expectRecord(parseJsonUnknown(firstRun(api)[1]))
  assert.equal(payload['turnTreeId'], 'tree-1', 'the turn-tree epoch is threaded to main')
  assert.equal(payload['continuationBudgetUsed'], 3, 'seed reflects this drain (2 prior + 1)')
})

test('held-on-exhaustion (decision 5): a machine follow-up over budget flips to held + a visible note', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, DEFAULT_CONTINUATION_BUDGET) // budget exhausted
  const messageId = addMessage(store, threadId, 'user', 'over-budget follow-up')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'over-budget follow-up' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'e1',
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0, 'an over-budget machine follow-up must not auto-submit')
  const thread = getThread(store, threadId)
  const item = at(thread.pendingMessages ?? [], 0)
  assert.equal(isHeldMessage(item), true, 'the over-budget follow-up is held')
  assert.equal(
    thread.messages.some((m) => m.role === 'error' && m.content === continuationBudgetHeldNote()),
    true,
    'a visible thread note explains the hold',
  )
})

test('held-on-exhaustion (decision 5): a human item behind an over-budget machine item still drains', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, DEFAULT_CONTINUATION_BUDGET)
  const hookId = addMessage(store, threadId, 'user', 'machine follow-up')
  const humanId = addMessage(store, threadId, 'user', 'human prompt')
  enqueueUserMessage(store, threadId, {
    messageId: hookId,
    payload: { content: 'machine follow-up' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'e1',
  })
  enqueueUserMessage(store, threadId, {
    messageId: humanId,
    payload: { content: 'human prompt' },
    createdAt: 2,
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 1, 'the human prompt drains past the over-budget machine item')
  assert.match(firstRun(api)[1], /human prompt/)
  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    [hookId],
    'the over-budget machine item stays queued, now held',
  )
  assert.equal(isHeldMessage(at(thread.pendingMessages ?? [], 0)), true)
})

test('budget (decision 5): a human-authored queued message never consumes budget', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, 3)
  const messageId = addMessage(store, threadId, 'user', 'human follow-up')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'human follow-up' },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 1)
  assert.equal(
    getThread(store, threadId).continuationUsed,
    3,
    'a human message does not spend the machine-turn budget',
  )
})

test('budget reset (decision 5): startHumanTurnTree resets continuationUsed to 0', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, DEFAULT_CONTINUATION_BUDGET)

  startHumanTurnTree(store, threadId)

  assert.equal(getThread(store, threadId).continuationUsed, 0)
})

test('budget reset (decision 5): releaseHeldMessage resets the budget for the fresh turn tree', () => {
  const store = createProjectStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, DEFAULT_CONTINUATION_BUDGET)
  setCurrentEpoch(store, threadId, 'epoch-stale')
  const messageId = addMessage(store, threadId, 'user', 'held work')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'held work' },
    createdAt: 1,
    origin: HOOK_ORIGIN,
    epoch: 'epoch-stale',
    autoDispatch: false,
  })

  releaseHeldMessage(store, api, threadId, messageId)

  assert.equal(api.runs.length, 1, 'release dispatches the held item')
  // The budget reset to 0 for the fresh turn tree, then the released item drained
  // as that tree's first machine turn (1 of a fresh 5) — down from the exhausted
  // cap, so further follow-ups are allowed again instead of being held.
  assert.equal(getThread(store, threadId).continuationUsed, 1)
})

test('run→drain fold-back (decision 5 / E3): folds the run in-run spend onto the same turn tree', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  setCurrentEpoch(store, threadId, 'tree-1')
  setContinuationUsed(store, threadId, 1) // the renderer seeded 1 drain-time continuation

  // The run spent 3 machine turns total (seed 1 + 2 in-run tighteners); fold back.
  foldBackContinuationUsed(store, threadId, 'tree-1', 3)

  assert.equal(getThread(store, threadId).continuationUsed, 3)
})

test('run→drain fold-back is monotonic within a turn tree (never lowers the counter)', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  setCurrentEpoch(store, threadId, 'tree-1')
  setContinuationUsed(store, threadId, 4)

  foldBackContinuationUsed(store, threadId, 'tree-1', 2)

  assert.equal(getThread(store, threadId).continuationUsed, 4, 'a lower report never wins')
})

test('run→drain fold-back is dropped for a stale turn tree (decision 16)', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  // A human action since the run started minted a new epoch + reset the budget.
  setCurrentEpoch(store, threadId, 'tree-2')
  setContinuationUsed(store, threadId, 0)

  foldBackContinuationUsed(store, threadId, 'tree-1', 3)

  assert.equal(
    getThread(store, threadId).continuationUsed,
    0,
    'a fold-back from the old turn tree must not clobber the reset',
  )
})

test('run→drain fold-back applies via the thread-id fallback when no epoch was minted', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  // No currentEpoch: the run keyed its ledger by the thread id (main-process
  // fallback), so a fold-back carrying that key is this thread's own spend.
  setContinuationUsed(store, threadId, 0)

  foldBackContinuationUsed(store, threadId, threadId, 2)

  assert.equal(getThread(store, threadId).continuationUsed, 2)
})

test('run→drain fold-back with a foreign key is dropped when no epoch was minted', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  setContinuationUsed(store, threadId, 0)

  foldBackContinuationUsed(store, threadId, 'tree-other', 3)

  assert.equal(getThread(store, threadId).continuationUsed, 0)
})
