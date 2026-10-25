import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  patchThreadAnywhere,
  setThreadGitBranch,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// `threads_changed` carries no thread id (src/shared/store/events.ts) and fires
// for any thread's rename, archive, status change or sidebar reorder — not only
// for the active thread. The conversation view used to rebuild on every one of
// these regardless of whether the active thread had anything to redraw: a
// background thread's own activity tore down and rebuilt the visible
// transcript, flashing each reply's hover actions (fresh DOM nodes restart
// their opacity transition) and nudging the scroll position.
//
// Thread updates are immutable (patchThreadAnywhere spreads a new object), so
// an edit to a *different* thread leaves the active thread's own object
// reference untouched. We drive that directly: mount the real view over a
// seeded message with a link, rename an unrelated thread (which still emits
// the coarse threads_changed), and assert the existing message + link DOM
// nodes survive by identity — a node changing identity would mean the list
// was rebuilt.

function fakeApi(
  resolveFileReferences: ApiClient['index']['resolveFileReferences'] = () => Promise.resolve([]),
): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
      index: {
        ...base['index'],
        resolveFileReferences,
      },
    } satisfies ApiClient
  })()
}

const unmounts: (() => void)[] = []

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('conversation does not rebuild on an unrelated thread_changed (component)', () => {
  it('keeps existing message and link DOM nodes when a different thread is renamed', () => {
    const store = createStore()
    const otherThreadId = createThread(store)
    // createThread activates whichever thread it just created, so this one —
    // created second — is the active thread the view renders.
    const threadId = createThread(store)
    const messageId = addMessage(
      store,
      threadId,
      'assistant',
      'See [Example Domain](https://example.com) for details.',
    )
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const msgNode = document.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(msgNode, 'expected the seeded assistant message to render')
    const linkNode = msgNode.querySelector('a')
    assert.ok(linkNode, 'expected the markdown link to render as an anchor')
    assert.match(linkNode.getAttribute('href') ?? '', /example\.com/)

    // Renaming the *other*, inactive thread still emits the coarse
    // threads_changed; the active conversation must ignore it.
    setThreadTitle(store, otherThreadId, 'Renamed in the background')

    // Same node objects ⇒ the conversation was not torn down and rebuilt.
    assert.equal(
      document.querySelector(`[data-message-id="${messageId}"]`),
      msgNode,
      'message node identity changed — the conversation rebuilt for an unrelated thread',
    )
    assert.equal(
      document.querySelector(`[data-message-id="${messageId}"] a`),
      linkNode,
      'link node identity changed — the conversation rebuilt for an unrelated thread',
    )
    assert.equal(document.querySelectorAll('.messages-list .msg').length, 1)
    assert.equal(document.querySelectorAll('.messages-list a[data-browser-link]').length, 1)
  })
})

describe('conversation does not rebuild when only the active thread metadata changes (component)', () => {
  it('keeps resolved file-reference links when the active thread is renamed or its branch moves', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(
      store,
      threadId,
      'assistant',
      'The palette builds entries in `src/renderer/views/command-palette.ts`.',
    )
    let resolveCalls = 0
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(
      host,
      store,
      fakeApi((candidates) => {
        resolveCalls++
        return Promise.resolve(
          candidates.map((candidate) => ({ candidate, path: candidate, kind: 'file' as const })),
        )
      }),
    )
    unmounts.push(unmount)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const link = document.querySelector(`[data-message-id="${messageId}"] a.file-reference-link`)
    assert.ok(link, 'expected the inline path to resolve into a file-reference link')
    assert.equal(resolveCalls, 1)

    // The active thread's own object is replaced each time, but nothing the
    // transcript draws changed: the resolved link must stay on screen.
    setThreadTitle(store, threadId, 'Renamed')
    setThreadGitBranch(store, threadId, 'copse/new-branch')
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      messages: [...thread.messages],
    }))
    store.emit('threads_changed')

    // assert.ok, not assert.equal: a failing equal on two DOM nodes makes node
    // inspect them for the diff, which hangs on happy-dom's object graph.
    assert.ok(
      document.querySelector(`[data-message-id="${messageId}"] a.file-reference-link`) === link,
      'the transcript rebuilt for an active-thread metadata change and dropped the resolved link',
    )
    assert.equal(resolveCalls, 1, 'no rebuild means no second resolve round-trip')
  })

  it('still rebuilds when the transcript messages change', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'First draft.')
    const host = document.createElement('div')
    document.body.append(host)
    unmounts.push(mountConversation(host, store, fakeApi()))
    const before = document.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(before)

    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      messages: thread.messages.map((message) => ({ ...message, content: 'Edited.' })),
    }))
    store.emit('threads_changed')

    const after = document.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(after)
    assert.ok(after !== before, 'expected a fresh message node after the transcript changed')
    assert.match(after.textContent, /Edited\./)
  })
})
