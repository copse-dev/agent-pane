import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  setThreadComparison,
  setThreadReviewReport,
  setMessageReviewReport,
  setMessageReview,
} from '@shared/store/thread-helpers.ts'
import type { ThreadReviewReport } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The Copse Reviewer findings card takes the trailing slot the comparison card
// had: it renders inside the scrolling message list as a trailing card, new
// messages arriving after it are inserted above it, and a retired comparison
// card (history) still sits after it.

function fakeApi(): ApiClient {
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
        resolveFileReferences: () => Promise.resolve([]),
      },
    } satisfies ApiClient
  })()
}

function report(status: ThreadReviewReport['status'] = 'done'): ThreadReviewReport {
  return {
    status,
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
    ...(status === 'error' ? { error: 'Review declined.' } : {}),
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('review report renders inline in the transcript (component)', () => {
  it('keeps two new reports beside their own messages as later turns arrive', () => {
    const store = createStore()
    const threadId = createThread(store)
    const firstId = addMessage(store, threadId, 'assistant', 'First change.')
    addMessage(store, threadId, 'user', 'Please revise it.')
    const secondId = addMessage(store, threadId, 'assistant', 'Second change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setMessageReviewReport(store, threadId, firstId, report())
    setMessageReviewReport(store, threadId, secondId, {
      ...report(),
      startedAt: 2,
      note: 'Second review',
    })
    addMessage(store, threadId, 'user', 'Another request.')

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const children = [...list.children]
    const firstMessage = children.findIndex(
      (child) => child.getAttribute('data-message-id') === firstId,
    )
    const firstReport = children.findIndex(
      (child) => child.getAttribute('data-review-report-for') === firstId,
    )
    const secondMessage = children.findIndex(
      (child) => child.getAttribute('data-message-id') === secondId,
    )
    const secondReport = children.findIndex(
      (child) => child.getAttribute('data-review-report-for') === secondId,
    )
    assert.equal(firstReport, firstMessage + 1)
    assert.equal(secondReport, secondMessage + 1)
    assert.ok(firstReport < secondMessage)
    assert.equal(list.querySelectorAll('[data-review-report-card]').length, 2)

    setMessageReviewReport(store, threadId, firstId, report('error'))
    assert.equal(list.querySelectorAll('[data-review-report-card]').length, 2)
    assert.ok(list.querySelector(`[data-review-report-for="${secondId}"]`))
  })

  it('mounts the findings card as the last child of .messages-list', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Done with the change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReviewReport(store, threadId, report())

    const card = document.querySelector('[data-review-report-card]')
    assert.ok(card, 'expected the findings card to render')
    const list = document.querySelector('.messages-list')
    assert.ok(list)
    assert.ok(list.contains(card), 'findings card must scroll with the conversation')
    assert.equal(list.lastElementChild, card, 'findings card should be the last child')
  })

  it('keeps the findings card last when a new message arrives after it', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'First turn.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReviewReport(store, threadId, report())
    addMessage(store, threadId, 'user', 'Another request.')

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const card = list.querySelector('[data-review-report-card]')
    assert.ok(card)
    assert.equal(list.lastElementChild, card, 'a later message must be inserted above the card')
  })

  it('replaces the previous card on each update and sits before a retired comparison', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadComparison(store, threadId, {
      status: 'done',
      models: { a: 'a', b: 'b', judge: 'j' },
      reviewA: 'A',
      reviewB: 'B',
      synthesis: 'S',
    })
    setThreadReviewReport(store, threadId, report('running'))
    setThreadReviewReport(store, threadId, report())
    setMessageReview(store, threadId, messageId, { status: 'done', summary: 'Looks correct.' })

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    assert.equal(list.querySelectorAll('[data-review-report-card]').length, 1)
    const children = [...list.children]
    const reviewIdx = children.findIndex((c) => c.hasAttribute('data-review-card'))
    const reportIdx = children.findIndex((c) => c.hasAttribute('data-review-report-card'))
    const compareIdx = children.findIndex((c) => c.hasAttribute('data-comparison-card'))
    assert.ok(reviewIdx >= 0 && reportIdx >= 0 && compareIdx >= 0, 'all three cards present')
    assert.ok(reviewIdx < reportIdx, 'the post-turn review card stays with its message')
    assert.ok(reportIdx < compareIdx, 'the retired comparison card stays last')
  })

  it('dismissing a failed review clears it from the store and removes the card', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Done with the change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadReviewReport(store, threadId, report('error'))
    const dismiss = document.querySelector<HTMLButtonElement>(
      '[data-review-report-card] .card-dismiss-button',
    )
    assert.ok(dismiss, 'expected a dismiss button on the failed card')
    dismiss.click()

    assert.equal(document.querySelector('[data-review-report-card]'), null)
    const thread = store.getState().threads.find((t) => t.id === threadId)
    assert.ok(thread)
    assert.equal(thread.reviewReport, undefined, 'dismissal must clear the persisted report')
  })
})
