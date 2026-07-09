import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setMessageReview } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Guards issue #480 ("Review mode sticks to the bottom of chat") and the move to
// per-turn inline reviews: the post-turn review no longer lives in a sibling host
// pinned below the scroller, nor as a single trailing card. It renders INSIDE the
// scrolling message list (.messages-list) as the next sibling of the message that
// concluded the reviewed turn, so it scrolls with the transcript and each turn
// keeps its own review in position.

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
  it('mounts the review card as the next sibling of its anchoring message', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Done with the change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setMessageReview(store, threadId, messageId, { status: 'done', summary: 'Looks correct.' })

    const list = document.querySelector('.messages-list')
    assert.ok(list, 'expected the scrolling message list to exist')
    const card = list.querySelector('[data-review-card]')
    assert.ok(card, 'expected the review card to render')
    assert.ok(
      list.contains(card),
      'review card must be a descendant of .messages-list so it scrolls with the conversation',
    )
    // It is anchored to its message: the card is that message's immediate sibling.
    const msgEl = list.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(msgEl)
    assert.equal(msgEl.nextElementSibling, card, 'review card must follow its message')
    assert.equal(card.getAttribute('data-review-for'), messageId)
    // And it must NOT live in a sibling host pinned below the scroller.
    assert.equal(
      document.querySelector('.conversation-review-host'),
      null,
      'the pinned review host should no longer exist',
    )
  })

  it('keeps a single card per message across status transitions', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setMessageReview(store, threadId, messageId, { status: 'running', summary: '' })
    setMessageReview(store, threadId, messageId, { status: 'done', summary: '1 likely bug.' })

    const cards = document.querySelectorAll(`[data-review-for="${messageId}"]`)
    assert.equal(cards.length, 1, 'only one review card should exist for a message after an update')
  })

  it('renders a separate review per turn, each anchored in position', () => {
    const store = createStore()
    const threadId = createThread(store)
    const first = addMessage(store, threadId, 'assistant', 'First turn.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setMessageReview(store, threadId, first, { status: 'done', summary: 'First review.' })
    // A second turn arrives and gets its own review.
    const second = addMessage(store, threadId, 'assistant', 'Second turn.')
    setMessageReview(store, threadId, second, { status: 'done', summary: 'Second review.' })

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const cards = list.querySelectorAll('[data-review-card]')
    assert.equal(cards.length, 2, 'each turn keeps its own review card')
    // Order in the transcript: first message, its review, second message, its review.
    const order = [...list.children].map(
      (c) => c.getAttribute('data-message-id') ?? c.getAttribute('data-review-for'),
    )
    assert.deepEqual(order, [first, first, second, second])
  })

  it('keeps a review anchored above a message added after it', () => {
    const store = createStore()
    const threadId = createThread(store)
    const first = addMessage(store, threadId, 'assistant', 'First turn.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setMessageReview(store, threadId, first, { status: 'done', summary: 'Looks correct.' })
    // A follow-up message arrives (emits message_added).
    const next = addMessage(store, threadId, 'user', 'Another request.')

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const children = [...list.children]
    const cardIdx = children.findIndex((c) => c.getAttribute('data-review-for') === first)
    const nextIdx = children.findIndex((c) => c.getAttribute('data-message-id') === next)
    assert.ok(cardIdx >= 0 && nextIdx >= 0, 'both the review card and the new message should exist')
    // The new message must land after the earlier turn's review card.
    assert.ok(
      cardIdx < nextIdx,
      'a message added after a review must be inserted below that review card',
    )
  })
})
