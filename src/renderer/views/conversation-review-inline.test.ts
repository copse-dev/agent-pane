import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadReview } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Guards issue #480: "Review mode sticks to the bottom of chat". The post-turn
// review card used to live in a sibling host (.conversation-review-host) below
// the scrolling message list, so it stayed pinned to the bottom regardless of
// scroll. It must now render INSIDE the scroller (.messages-list) as the last
// child so it scrolls with the transcript.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: { resolveFileReferences: () => Promise.resolve([]) },
  } as unknown as ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('post-turn review renders inline in the transcript (component)', () => {
  it('mounts the review card as a descendant of .messages-list', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Done with the change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReview(store, threadId, { status: 'done', summary: 'Looks correct.' })

    const card = document.querySelector('[data-review-card]')
    assert.ok(card, 'expected the review card to render')
    const list = document.querySelector('.messages-list')
    assert.ok(list, 'expected the scrolling message list to exist')
    assert.ok(
      list.contains(card),
      'review card must be a descendant of .messages-list so it scrolls with the conversation',
    )
    // It should be the last child of the list (joins the transcript at the end).
    assert.equal(list.lastElementChild, card, 'review card should be the last child of the list')
    // And it must NOT live in a sibling host pinned below the scroller.
    assert.equal(
      document.querySelector('.conversation-review-host'),
      null,
      'the pinned review host should no longer exist',
    )
  })

  it('keeps the review card last when a new message arrives after a review', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'First turn.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReview(store, threadId, { status: 'done', summary: 'Looks correct.' })
    // A follow-up message arrives (emits message_added).
    addMessage(store, threadId, 'user', 'Another request.')

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const card = list.querySelector('[data-review-card]')
    assert.ok(card, 'review card should still be present')
    assert.equal(
      list.lastElementChild,
      card,
      'a message added after a review must be inserted above the review card',
    )
  })

  it('replaces the previous review card on each review update', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Working.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReview(store, threadId, { status: 'running', summary: '' })
    setThreadReview(store, threadId, { status: 'done', summary: '1 likely bug.' })

    const cards = document.querySelectorAll('[data-review-card]')
    assert.equal(cards.length, 1, 'only one review card should exist after an update')
  })
})
