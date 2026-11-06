import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  patchThreadAnywhere,
  setThreadReviewReport,
} from '@shared/store/thread-helpers.ts'
import type { Thread, ThreadReviewReport } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { attachThreadHydration } from '../controller/thread-hydration.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The keyed row reconcile (transcript-rows.ts) used to give up, and rebuild
// every row, while the transcript was still loading (its notice changing as a
// turn starts or ends, or the read failing), while older history was still
// backfilling above the newest-first window, and when kept rows would have to
// move. Each of these now patches the list in place: the rows and the chrome
// that did not change are the same nodes afterwards, and the list draws what a
// fresh mount of the same store draws.

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: { ...base['index'], resolveFileReferences: () => Promise.resolve([]) },
    ...overrides,
  } satisfies ApiClient
}

const cleanups: (() => void)[] = []
const realRequestAnimationFrame = globalThis.requestAnimationFrame
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.requestAnimationFrame = realRequestAnimationFrame
  document.body.replaceChildren()
})

function mount(store: AppStore, api: ApiClient = fakeApi()): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountConversation(host, store, api))
  return host
}

/** Hold animation frames until {@link flush}, so a backfill stays pending. */
function holdFrames(): { flush: () => void } {
  let queued: ((time: number) => void)[] = []
  globalThis.requestAnimationFrame = (callback): number => {
    queued.push(callback)
    return queued.length
  }
  return {
    flush: (): void => {
      while (queued.length > 0) {
        const callbacks = queued
        queued = []
        for (const callback of callbacks) callback(0)
      }
    },
  }
}

function listRows(host: HTMLElement): string[] {
  return Array.from(
    host.querySelectorAll('.messages-list > :not(.agent-activity)'),
    (child) => child.outerHTML,
  )
}

async function assertMatchesFreshMount(
  store: AppStore,
  live: HTMLElement,
  label: string,
  api: ApiClient = fakeApi(),
): Promise<void> {
  // The fresh view draws its whole history at once.
  globalThis.requestAnimationFrame = realRequestAnimationFrame
  const fresh = document.createElement('div')
  document.body.append(fresh)
  const unmount = mountConversation(fresh, store, api)
  await delay(0)
  const reconciled = listRows(live)
  const rebuilt = listRows(fresh)
  unmount()
  fresh.remove()
  assert.equal(reconciled.length, rebuilt.length, `${label}: row count`)
  const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
  assert.equal(firstDifference, -1, `${label}: row ${String(firstDifference)} differs`)
}

function rowNodes(host: HTMLElement): Map<string, Element> {
  return new Map(
    Array.from(host.querySelectorAll<HTMLElement>('.messages-list > [data-message-id]'), (row) => [
      row.dataset['messageId'] ?? '',
      row,
    ]),
  )
}

function rowIds(host: HTMLElement): string[] {
  return [...rowNodes(host).keys()]
}

function report(): ThreadReviewReport {
  return {
    status: 'done',
    startedAt: 1,
    models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
    lenses: ['correctness'],
    baseRef: 'HEAD',
    headCommit: 'abc',
    dirtyWorkingTree: true,
    execution: { backend: 'os-sandbox', strength: 'os-sandbox', executed: true, reason: '' },
    checks: [],
    notChecked: [],
    findings: [],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 1,
  }
}

function patchThread(store: AppStore, threadId: string, patch: Partial<Thread>): void {
  patchThreadAnywhere(store, threadId, (thread) => ({ ...thread, ...patch }))
  store.emit('threads_changed')
}

describe('conversation keyed row reconcile: loading transcripts (component)', () => {
  it('patches the hydration notice in place as the loading turn ends', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const host = mount(store)
    setThreadReviewReport(store, threadId, report())
    patchThread(store, threadId, { status: 'running', messages: [], messagesLoaded: false })
    const notice = host.querySelector('.conversation-hydrating')
    const card = host.querySelector('[data-review-report-card]')
    assert.ok(notice && card)
    assert.equal(notice.textContent, 'Agent is working — loading the conversation…')

    // A rename changes nothing the transcript draws: the notice is kept.
    patchThread(store, threadId, { title: 'Renamed while loading' })
    assert.ok(host.querySelector('.conversation-hydrating') === notice, 'the notice was redrawn')

    // The turn ends while the transcript is still loading.
    patchThread(store, threadId, { status: 'idle' })
    const idle = host.querySelector('.conversation-hydrating')
    assert.ok(idle)
    assert.equal(idle.textContent, 'Loading the conversation…')
    assert.equal(host.querySelectorAll('.conversation-hydrating').length, 1)
    assert.ok(host.querySelector('[data-review-report-card]') === card, 'the report was redrawn')
    assert.ok(idle.nextElementSibling?.classList.contains('agent-activity') === true)
    await assertMatchesFreshMount(store, host, 'idle while loading')
  })

  it('swaps in the failure line in place when the read fails', async () => {
    const store = createStore({ activeProjectId: 'p' })
    const threadId = createThread(store)
    const base = fakeApi()
    const failing = fakeApi({
      threads: { ...base.threads, loadMessages: () => Promise.reject(new Error('disk gone')) },
    })
    const host = mount(store, failing)
    setThreadReviewReport(store, threadId, report())
    cleanups.push(attachThreadHydration(store, failing))
    // Switching into a thread that is not loaded yet is a fresh build; the
    // read then fails asynchronously.
    patchThread(store, threadId, { status: 'running', messages: [], messagesLoaded: false })
    const card = host.querySelector('[data-review-report-card]')
    const activity = host.querySelector('.agent-activity')
    const removed: string[] = []
    const list = host.querySelector('.messages-list')
    assert.ok(card && activity && list)
    assert.ok(host.querySelector('.conversation-hydrating-running'))
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof HTMLElement) removed.push(node.className || node.tagName)
        }
      }
    }).observe(list, { childList: true })
    await delay(0)

    const failure = host.querySelector('.conversation-hydrating-failed')
    assert.equal(failure?.textContent, 'Couldn’t load the conversation.')
    assert.equal(host.querySelectorAll('.conversation-hydrating').length, 1)
    assert.ok(host.querySelector('[data-review-report-card]') === card, 'the report was redrawn')
    assert.ok(host.querySelector('.agent-activity') === activity)
    assert.deepEqual(
      removed,
      ['conversation-hydrating conversation-hydrating-running'],
      'only the loading notice leaves the list',
    )
    await assertMatchesFreshMount(store, host, 'failed read', failing)
  })
})

describe('conversation keyed row reconcile: pending backfill and reorders (component)', () => {
  function longThread(store: AppStore, total: number): { threadId: string; ids: string[] } {
    const threadId = createThread(store)
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      ids.push(
        addMessage(store, threadId, i % 2 === 0 ? 'user' : 'assistant', `message ${String(i)}`),
      )
    }
    return { threadId, ids }
  }

  it('reconciles the rendered window while older history is still backfilling', async () => {
    const store = createStore()
    const { threadId, ids } = longThread(store, 97)
    const frames = holdFrames()
    const host = mount(store)
    // Only the newest-first window is in the list; the backfill is queued.
    const window = rowNodes(host)
    assert.equal(window.size, 40)
    const windowIds = ids.slice(-40)
    assert.deepEqual([...window.keys()], windowIds)

    // A new turn lands, and an older message the backfill has yet to render
    // is edited, before the backfill has run.
    const prompt = addMessage(store, threadId, 'user', 'A new prompt')
    patchThread(store, threadId, {
      messages: (store.getState().threads.find((t) => t.id === threadId)?.messages ?? []).map(
        (message) => (message.id === ids[3] ? { ...message, content: 'edited early' } : message),
      ),
    })
    store.emit('threads_changed')

    const during = rowNodes(host)
    for (const id of windowIds) assert.ok(during.get(id) === window.get(id), `${id} was rebuilt`)
    assert.deepEqual([...during.keys()], [...windowIds, prompt])

    frames.flush()
    assert.deepEqual(rowIds(host), [...ids, prompt], 'the backfill completes in order')
    const after = rowNodes(host)
    for (const id of windowIds) assert.ok(after.get(id) === window.get(id), `${id} was rebuilt`)
    assert.match(after.get(ids[3] ?? '')?.textContent ?? '', /edited early/)
    await assertMatchesFreshMount(store, host, 'after the backfill')
  })

  it('rebuilds when the part still to backfill loses a message', () => {
    const store = createStore()
    const { threadId, ids } = longThread(store, 97)
    const frames = holdFrames()
    const host = mount(store)
    const window = rowNodes(host)
    // Truncating at an early message removes rows the backfill was to render.
    patchThread(store, threadId, {
      messages: (store.getState().threads.find((t) => t.id === threadId)?.messages ?? []).filter(
        (message) => message.id !== ids[2],
      ),
    })
    frames.flush()
    const expected = ids.filter((id) => id !== ids[2])
    assert.deepEqual(rowIds(host), expected)
    assert.ok(rowNodes(host).get(ids.at(-1) ?? '') !== window.get(ids.at(-1) ?? ''))
  })

  it('moves reordered rows instead of rebuilding the list', async () => {
    const store = createStore()
    const { threadId, ids } = longThread(store, 6)
    const host = mount(store)
    const before = rowNodes(host)
    const messages = store.getState().threads.find((t) => t.id === threadId)?.messages ?? []
    // Two settled exchanges swap places.
    const order = [0, 1, 4, 5, 2, 3].map((i) => messages[i]).filter((m) => m !== undefined)
    patchThread(store, threadId, { messages: order })

    const expected = [0, 1, 4, 5, 2, 3].map((i) => ids[i] ?? '')
    assert.deepEqual(rowIds(host), expected)
    const after = rowNodes(host)
    for (const id of ids) assert.ok(after.get(id) === before.get(id), `${id} was rebuilt`)
    await assertMatchesFreshMount(store, host, 'reordered')
  })
})
