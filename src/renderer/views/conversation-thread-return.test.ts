import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendAcpContentBlock,
  createThread,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// Switching away from a thread and back used to build every row again, so the
// reply's resolved file link fell back to inline code until its async resolve
// landed again, and the tool card the reader had opened closed. The view now
// keeps the rows of the thread it switches away from and, on the return,
// reconciles them with the thread as it is: unchanged rows are the same nodes,
// and the list draws what a fresh mount draws.

function fakeApi(resolveCalls: { count: number }): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: {
      ...base['index'],
      resolveFileReferences: (
        candidates,
      ): ReturnType<ApiClient['index']['resolveFileReferences']> => {
        resolveCalls.count++
        return Promise.resolve(
          candidates.map((candidate) => ({ candidate, path: candidate, kind: 'file' as const })),
        )
      },
    },
  } satisfies ApiClient
}

const cleanups: (() => void)[] = []
const realRequestAnimationFrame = globalThis.requestAnimationFrame
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.requestAnimationFrame = realRequestAnimationFrame
  document.body.replaceChildren()
})

function mount(store: AppStore, resolveCalls = { count: 0 }): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountConversation(host, store, fakeApi(resolveCalls)))
  return host
}

interface Seeded {
  store: AppStore
  threadId: string
  answer: string
  host: HTMLElement
  resolveCalls: { count: number }
}

/** A finished turn whose answer carries a file path and a tool card, mounted. */
async function seed(): Promise<Seeded> {
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Where are palette entries built?')
  const answer = addMessage(
    store,
    threadId,
    'assistant',
    'The palette builds entries in `src/renderer/views/command-palette.ts`.',
  )
  addToolCall(store, answer, {
    id: 'tc-read',
    name: 'read_file',
    args: { path: 'src/renderer/views/command-palette.ts' },
    status: 'done',
    result: 'export function mountCommandPalette() {}',
  })
  const resolveCalls = { count: 0 }
  const host = mount(store, resolveCalls)
  await delay(0)
  return { store, threadId, answer, host, resolveCalls }
}

/** Switch to a new thread, then back to `threadId`, the way the sidebar does. */
async function switchAwayAndBack(
  store: AppStore,
  threadId: string,
  whileAway: () => void = () => {},
): Promise<void> {
  const other = createThread(store)
  // Not blank, so switching back does not prune it mid-test.
  addMessage(store, other, 'user', 'Something else')
  store.emit('threads_changed')
  whileAway()
  store.setState({ activeThreadId: threadId })
  store.emit('threads_changed')
  await delay(0)
}

function rowNodes(host: HTMLElement): Map<string, Element> {
  return new Map(
    Array.from(host.querySelectorAll<HTMLElement>('.messages-list > [data-message-id]'), (row) => [
      row.dataset['messageId'] ?? '',
      row,
    ]),
  )
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
): Promise<void> {
  globalThis.requestAnimationFrame = realRequestAnimationFrame
  const fresh = document.createElement('div')
  document.body.append(fresh)
  const unmount = mountConversation(fresh, store, fakeApi({ count: 0 }))
  await delay(0)
  const reconciled = listRows(live)
  const rebuilt = listRows(fresh)
  unmount()
  fresh.remove()
  assert.equal(reconciled.length, rebuilt.length, `${label}: row count`)
  const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
  assert.equal(firstDifference, -1, `${label}: row ${String(firstDifference)} differs`)
}

/** Open the answer's tool card the way the reader does; returns it and the link. */
function openAnswer(
  host: HTMLElement,
  answer: string,
): { card: HTMLDetailsElement; link: Element } {
  const row = qsRequired(host, `.messages-list > [data-message-id="${answer}"]`)
  const link = row.querySelector('a.file-reference-link')
  assert.ok(link, 'expected the inline path to resolve into a file-reference link')
  const card = qsRequired<HTMLDetailsElement>(row, '[data-tool-id="tc-read"]')
  qsRequired(card, ':scope > summary').click()
  assert.equal(card.open, true)
  return { card, link }
}

describe('conversation: returning to a recently viewed thread (component)', () => {
  it('keeps the rows, the resolved link and the open tool card', async () => {
    const { store, threadId, answer, host, resolveCalls } = await seed()
    const before = rowNodes(host)
    const { card, link } = openAnswer(host, answer)
    const resolvesBefore = resolveCalls.count

    await switchAwayAndBack(store, threadId)

    const after = rowNodes(host)
    assert.deepEqual([...after.keys()], [...before.keys()])
    for (const [id, node] of before) assert.ok(after.get(id) === node, `${id} was rebuilt`)
    const row = after.get(answer)
    assert.ok(row?.querySelector('a.file-reference-link') === link, 'the resolved link was lost')
    assert.ok(row.querySelector('[data-tool-id="tc-read"]') === card, 'the tool card was rebuilt')
    assert.equal(card.open, true, 'the open disclosure was closed')
    assert.equal(resolveCalls.count, resolvesBefore, 'the kept rows resolved their paths again')

    // The reader's toggle still reaches the disclosure model on the kept card.
    qsRequired(card, ':scope > summary').click()
    assert.equal(card.open, false)
    await switchAwayAndBack(store, threadId)
    assert.equal(card.open, false, 'the closed choice did not survive the next return')
    // A fresh mount would draw what the reader left behind differently (the
    // toggled card and its built body), which is the point; the other cases
    // compare with a fresh mount.
  })

  it('reconciles what changed while the thread was away', async () => {
    const { store, threadId, answer, host } = await seed()
    const before = rowNodes(host)
    let added = ''
    await switchAwayAndBack(store, threadId, () => {
      added = addMessage(store, threadId, 'assistant', 'A late note from a background turn.')
    })
    const after = rowNodes(host)
    assert.deepEqual([...after.keys()], [...before.keys(), added])
    assert.ok(after.get(answer) === before.get(answer), 'the answer row was rebuilt')
    await assertMatchesFreshMount(store, host, 'with a message added while away')
  })

  it('restores the newest window at once and reattaches older rows as the history backfills', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const ids: string[] = []
    for (let i = 0; i < 97; i++) {
      ids.push(
        addMessage(store, threadId, i % 2 === 0 ? 'user' : 'assistant', `message ${String(i)}`),
      )
    }
    const host = mount(store)
    const before = rowNodes(host)
    assert.equal(before.size, 97)

    let queued: ((time: number) => void)[] = []
    globalThis.requestAnimationFrame = (callback): number => {
      queued.push(callback)
      return queued.length
    }
    await switchAwayAndBack(store, threadId)
    // Like a fresh build, only the newest window blocks the switch.
    assert.deepEqual([...rowNodes(host).keys()], ids.slice(-40))
    while (queued.length > 0) {
      const callbacks = queued
      queued = []
      for (const callback of callbacks) callback(0)
    }
    const after = rowNodes(host)
    assert.deepEqual([...after.keys()], ids)
    for (const [id, node] of before) assert.ok(after.get(id) === node, `${id} was rebuilt`)
    await assertMatchesFreshMount(store, host, 'after the backfill')
  })

  it('builds a running thread afresh, since its rows change while away', async () => {
    const { store, threadId, answer, host } = await seed()
    setThreadStatus(store, threadId, 'running')
    store.emit('threads_changed')
    const before = rowNodes(host)
    await switchAwayAndBack(store, threadId, () => {
      setThreadStatus(store, threadId, 'idle')
    })
    assert.ok(rowNodes(host).get(answer) !== before.get(answer))
    await assertMatchesFreshMount(store, host, 'running thread')
  })

  it('shows an image preview whose read finished while the thread was away', async () => {
    const image = '/repo/images/shot.png'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'Take a screenshot.')
    const answer = addMessage(store, threadId, 'assistant', '')
    appendAcpContentBlock(store, answer, 'message', {
      type: 'resource_link',
      uri: image,
      name: image,
    })
    let finishRead: (src: string) => void = () => {}
    const base = fakeApi({ count: 0 })
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (): Promise<string> =>
          new Promise((resolve) => {
            finishRead = resolve
          }),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    cleanups.push(mountConversation(host, store, api))
    await delay(0)
    const row = rowNodes(host).get(answer)
    assert.ok(row, 'expected the answer row')
    assert.ok(row.querySelector('.acp-resource-link'), 'expected a pending image card')

    // The read lands while the row is stashed, detached from the list.
    const other = createThread(store)
    addMessage(store, other, 'user', 'Something else')
    store.emit('threads_changed')
    assert.equal(row.isConnected, false)
    finishRead('data:image/png;base64,aW1hZ2U=')
    await delay(0)
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    await delay(0)

    assert.ok(rowNodes(host).get(answer) === row, 'the answer row was rebuilt')
    assert.ok(row.querySelector('.acp-resource-image img'), 'the image preview never appeared')
  })

  it('builds again a row that hosts an inline canvas guest', async () => {
    const { store, threadId, answer, host } = await seed()
    const before = rowNodes(host)
    // A guest does not survive being detached, so its row is not kept.
    const guestRow = before.get(answer)
    assert.ok(guestRow)
    const guest = document.createElement('div')
    guest.className = 'canvas-inline-artefact'
    guestRow.append(guest)
    await switchAwayAndBack(store, threadId)
    const after = rowNodes(host)
    assert.ok(after.get(answer) !== guestRow, 'the guest row was kept')
    for (const [id, node] of before) {
      if (id !== answer) assert.ok(after.get(id) === node, `${id} was rebuilt`)
    }
    await assertMatchesFreshMount(store, host, 'guest row rebuilt')
  })
})
