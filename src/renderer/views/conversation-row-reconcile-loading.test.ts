import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { addMessage, createThread, patchThreadAnywhere } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The keyed row reconcile (transcript-rows.ts) used to give up, and rebuild
// every row, while older history was still backfilling above the
// newest-first window. It now patches the rows below the part the backfill has
// yet to render: the rows that did not change are the same nodes afterwards,
// and the list draws what a fresh mount of the same store draws. A loading
// transcript and kept rows that would have to move still rebuild the list.

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

function patchThread(store: AppStore, threadId: string, patch: Partial<Thread>): void {
  patchThreadAnywhere(store, threadId, (thread) => ({ ...thread, ...patch }))
  store.emit('threads_changed')
}

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

  it('rebuilds a reordered transcript and draws it as a fresh mount does', async () => {
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
    assert.ok(rowNodes(host).get(ids[4] ?? '') !== before.get(ids[4] ?? ''), 'the list was rebuilt')
    await assertMatchesFreshMount(store, host, 'reordered')
  })
})
