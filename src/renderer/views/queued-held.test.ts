import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  setThreadStatus,
  patchThreadAnywhere,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  continuationBudgetHeldNote,
  drainMessageQueue,
  enqueueUserMessage,
} from '../controller/message-queue.ts'
import { DEFAULT_CONTINUATION_BUDGET } from '@copse/agent/hooks/continuation-budget.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// C2 held-state UI (decisions 5 & 16). A hook-originated message downgraded to
// held renders with a distinct "Held" badge and a "Release" action (not the plain
// "Send now" of a normal queued item); clicking Release un-holds it and submits.
// Component-tier per docs/testing-strategy.md: the drain-skip + release semantics
// are unit-tested in controller/message-queue.test.ts; this covers the view's
// rendering of the held state and that the release control is wired.

function createProjectStore(): ReturnType<typeof createStore> {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  return store
}

function fakeApi(): ApiClient & { runs: Array<[string, string]>; aborts: string[] } {
  const runs: Array<[string, string]> = []
  const aborts: string[] = []
  return ((): ApiClient & { runs: Array<[string, string]>; aborts: string[] } => {
    const base = createFakeApi()
    return {
      ...base,
      runs,
      aborts,
      agent: {
        ...base['agent'],
        run: (_projectId: string, threadId: string, payload: string): Promise<void> => {
          runs.push([threadId, payload])
          return Promise.resolve()
        },
        abort: (threadId: string): Promise<void> => {
          aborts.push(threadId)
          return Promise.resolve()
        },
      },
    } satisfies ApiClient & { runs: Array<[string, string]>; aborts: string[] }
  })()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('held queued message (component)', () => {
  it('steers a human note with the live run nonce and holds it while awaiting a boundary', async () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    setThreadStatus(store, threadId, 'running')
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      nativeSteeringRunId: 'live-run',
      currentEpoch: 'human',
      continuationUsed: 5,
    }))
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const messageId = addMessage(store, threadId, 'user', 'Keep the existing API.')
    let resolveResult: (value: { state: 'applied' | 'held' }) => void = () =>
      assert.fail('Missing resolver')
    const result = new Promise<{ state: 'applied' | 'held' }>((resolve) => {
      resolveResult = resolve
    })
    api.agent.steer = (project, id, note, runId): Promise<{ state: 'applied' | 'held' }> => {
      assert.deepEqual([project, id, note, runId], ['project-1', threadId, messageId, 'live-run'])
      const pending = store.getState().threads.find((thread) => thread.id === threadId)
        ?.pendingMessages?.[0]
      assert.equal(pending?.autoDispatch, false)
      assert.equal(pending.steeringRequested, 'live-run')
      return result
    }
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'Keep the existing API.' },
      createdAt: 1,
    })
    const steer = document.querySelector<HTMLButtonElement>('.queued-steer')
    assert.ok(steer)
    steer.click()
    assert.match(document.querySelector('.steering-pending')?.textContent ?? '', /next agent step/)
    assert.equal(document.querySelector('.conversation-queued .queued-release'), null)
    assert.deepEqual(api.aborts, [])
    assert.deepEqual(api.runs, [])
    resolveResult({ state: 'held' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const thread = store.getState().threads.find((entry) => entry.id === threadId)
    assert.equal(thread?.pendingMessages?.[0]?.autoDispatch, false)
    assert.equal(thread.pendingMessages[0].steeringRequested, undefined)
    assert.equal(thread.continuationUsed, 5)
    assert.equal(thread.currentEpoch, 'human')
    assert.ok(document.querySelector('.queued-release'))
  })

  it('does not offer Steer without a native run or for machine messages', () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    setThreadStatus(store, threadId, 'running')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const messageId = addMessage(store, threadId, 'user', 'Next turn')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'Next turn' },
      createdAt: 1,
    })
    assert.equal(document.querySelector('.queued-steer'), null)
    patchThreadAnywhere(store, threadId, (thread) => ({ ...thread, nativeSteeringRunId: 'native' }))
    store.emit('threads_changed')
    assert.ok(
      document.querySelector('.queued-steer'),
      'a queued note becomes steerable when the native loop starts',
    )
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      nativeSteeringRunId: 'native',
      pendingMessages:
        thread.pendingMessages?.map((item) => ({
          ...item,
          origin: { kind: 'machine', operationId: 'peer' },
        })) ?? [],
    }))
    store.emit('threads_changed')
    assert.equal(document.querySelector('.queued-steer'), null)
  })
  it('renders a Held badge + Release action for a held hook message', () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const messageId = addMessage(store, threadId, 'user', 'late hook follow-up')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'late hook follow-up' },
      createdAt: 1,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'epoch-stale',
      autoDispatch: false,
    })

    const heldItem = document.querySelector<HTMLElement>(
      '.conversation-queued .msg-queued.msg-held',
    )
    assert.ok(heldItem, 'expected a held queued bubble')
    assert.equal(heldItem.dataset['hookId'], 'todo-closeout', 'hook provenance on the DOM node')
    assert.equal(
      document.querySelector('.msg-held .message-queued-badge')?.textContent,
      'Held',
      'held items badge as "Held", not "Queued"',
    )
    assert.ok(document.querySelector('.msg-held .queued-release'), 'expected a Release action')
    // A held item does not get the plain "Send now" affordance — release is the path.
    assert.equal(document.querySelector('.msg-held .queued-send-now'), null)
  })

  it('Release un-holds and dispatches the held message', () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const messageId = addMessage(store, threadId, 'user', 'release me')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'release me' },
      createdAt: 1,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'epoch-stale',
      autoDispatch: false,
    })
    setThreadStatus(store, threadId, 'idle')

    const releaseBtn = document.querySelector<HTMLButtonElement>('.msg-held .queued-release')
    assert.ok(releaseBtn, 'expected a Release button')
    releaseBtn.click()

    assert.equal(api.runs.length, 1, 'release dispatches the held message')
    assert.match(api.runs[0]?.[1] ?? '', /release me/)
    const thread = store.getState().threads.find((t) => t.id === threadId)
    assert.equal(
      thread?.pendingMessages ?? undefined,
      undefined,
      'the released item leaves the queue',
    )
    assert.notEqual(thread?.currentEpoch, 'epoch-stale', 'release starts a fresh turn tree')
  })

  // C3 (decision 5): a hook follow-up that arrives once the turn tree's
  // auto-continuation budget is exhausted flips to *held* at drain time — the
  // **same held UI** as C2's stale-epoch downgrade, only the seed reason differs
  // (over budget vs stale). This asserts the C3 drain-time path renders that UI
  // plus the visible budget note, so no new WDIO visual is needed.
  it('renders the held UI + budget note for an over-budget hook follow-up (drain-time)', () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    // Exhaust the budget, then a hook follow-up arrives and the queue drains.
    store.setState({
      threads: store
        .getState()
        .threads.map((t) =>
          t.id !== threadId ? t : { ...t, continuationUsed: DEFAULT_CONTINUATION_BUDGET },
        ),
    })
    const messageId = addMessage(store, threadId, 'user', 'over-budget follow-up')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'over-budget follow-up' },
      createdAt: 1,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'e1',
    })

    drainMessageQueue(store, api, threadId)

    assert.equal(api.runs.length, 0, 'the over-budget follow-up did not auto-submit')
    const heldItem = document.querySelector<HTMLElement>(
      '.conversation-queued .msg-queued.msg-held',
    )
    assert.ok(heldItem, 'the over-budget follow-up renders with the held UI')
    assert.ok(document.querySelector('.msg-held .queued-release'), 'held UI offers Release')
    // The visible thread note explaining the hold is added to the thread.
    assert.ok(
      store
        .getState()
        .threads.find((t) => t.id === threadId)
        ?.messages.some((m) => m.content === continuationBudgetHeldNote()),
      'a visible budget note is added to the thread',
    )
  })
})

describe('durable queued deletion (component)', () => {
  it('shows pending deletion without release actions, then removes only after acknowledgement', async () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const messageId = addMessage(store, threadId, 'user', 'delete this queued note')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'delete this queued note' },
      createdAt: 1,
    })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    api.threads.deleteQueuedMessage = (): Promise<void> => gate
    const button = document.querySelector<HTMLButtonElement>('.queued-delete')
    assert.ok(button)
    button.click()
    assert.match(document.querySelector('.conversation-queued')?.textContent ?? '', /Deleting…/)
    assert.equal(document.querySelector('.conversation-queued .queued-release'), null)
    assert.equal(document.querySelector('.conversation-queued .queued-send-now'), null)
    assert.equal(
      store.getState().threads[0]?.messages.some((message) => message.id === messageId),
      true,
    )
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(document.querySelector('.conversation-queued .msg-queued'), null)
    assert.equal(
      store.getState().threads[0]?.messages.some((message) => message.id === messageId),
      false,
    )
  })

  it('keeps a failed deletion visibly held and offers explicit retry', async () => {
    const store = createProjectStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const messageId = addMessage(store, threadId, 'user', 'keep on failure')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'keep on failure' },
      createdAt: 1,
    })
    api.threads.deleteQueuedMessage = (): Promise<void> =>
      Promise.reject(new Error('disk unavailable'))
    const button = document.querySelector<HTMLButtonElement>('.queued-delete')
    assert.ok(button)
    button.click()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.match(
      document.querySelector('.conversation-queued')?.textContent ?? '',
      /keep on failure/,
    )
    assert.ok(document.querySelector('.conversation-queued .msg-held .queued-delete'))
    assert.equal(store.getState().threads[0]?.pendingMessages?.[0]?.autoDispatch, false)
    assert.match(document.body.textContent, /Could not delete queued message/)
    assert.equal(api.runs.length, 0)
  })
})
