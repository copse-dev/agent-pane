import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread, setReviewerInputAnswer } from '@shared/store/thread-helpers.ts'
import type { Message } from '@shared/types'
import { formatDeferredAskUserResult } from '@copse/agent/ask-user-format.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createReviewerInputToolCard, mountReviewerInput } from './reviewer-input.ts'

test('compact requests expand and jump to their owning transcript message', () => {
  const store = createStore({ activeProjectId: 'project-1', workspaceRoot: '/repo' })
  const threadId = createThread(store)
  const message: Message = {
    id: 'message-7',
    role: 'assistant',
    content: 'Here is the issue.',
    createdAt: 1,
    toolCalls: [
      {
        id: 'request-3',
        name: 'request_review_input',
        status: 'done',
        result: 'Saved',
        args: {
          question: 'Fix the spacing too?',
          context: 'Footer overlap and blank space.',
          options: ['Both', 'Overlap only'],
        },
      },
    ],
  }
  store.setState({
    threads: store
      .getState()
      .threads.map((thread) =>
        thread.id === threadId ? { ...thread, messages: [message] } : thread,
      ),
  })
  const view = mountReviewerInput(store, createFakeApi())
  document.body.append(view.toggle, view.panel)
  view.sync()
  assert.equal(view.toggle.textContent, '1 question')
  assert.equal(view.panel.hidden, false)
  assert.equal(view.panel.querySelector('.reviewer-input-context'), null)

  let target: [string, string] | null = null
  const unsubscribe = store.on('reviewer_input_jump', (messageId, requestId) => {
    target = [messageId, requestId]
  })
  view.panel.querySelector<HTMLButtonElement>('.reviewer-input-origin')?.click()
  assert.deepEqual(target, ['message-7', 'request-3'])
  view.panel.querySelector<HTMLButtonElement>('.reviewer-input-question')?.click()
  assert.match(view.panel.textContent, /Footer overlap and blank space/)
  assert.equal(view.panel.querySelectorAll('.reviewer-input-option').length, 2)
  setReviewerInputAnswer(store, threadId, {
    id: 'request-3',
    text: 'Both',
    answeredAt: 2,
    messageId: 'answer-3',
  })
  view.sync()
  assert.equal(view.toggle.hidden, true)
  assert.equal(view.panel.hidden, true)
  assert.equal(view.panel.querySelector('.reviewer-input-item'), null)
  unsubscribe()
  view.toggle.remove()
  view.panel.remove()
})

test('saved unattended questions share a card while keeping their answers and origin links separate', () => {
  const store = createStore({ activeProjectId: 'project-1', workspaceRoot: '/repo' })
  const threadId = createThread(store)
  const message: Message = {
    id: 'saved-question-message',
    role: 'assistant',
    content: 'I checked the files.',
    createdAt: 1,
    toolCalls: [
      {
        id: 'saved-question-call',
        name: 'ask_user',
        status: 'done',
        result: formatDeferredAskUserResult([
          {
            question: 'Which channel?',
            options: ['Stable', 'Preview'],
            recommendedOption: 'Preview',
            recommendationReason: 'It is experimental.',
          },
          { question: 'Who signs off?', options: ['Editor', 'Maintainer'] },
        ]),
        args: {
          questions: [
            {
              question: 'Which channel?',
              options: ['Stable', 'Preview'],
              recommendedOption: 'Preview',
              recommendationReason: 'It is experimental.',
            },
            { question: 'Who signs off?', options: ['Editor', 'Maintainer'] },
          ],
        },
      },
    ],
  }
  store.setState({
    threads: store
      .getState()
      .threads.map((thread) =>
        thread.id === threadId ? { ...thread, messages: [message] } : thread,
      ),
  })
  const call = message.toolCalls[0]
  assert.ok(call)
  const card = createReviewerInputToolCard(call, store)
  assert.ok(card)
  assert.equal(card.querySelector('summary')?.textContent, 'Needs your input · 2 questions')
  assert.equal(card.querySelectorAll('.reviewer-input-origin').length, 2)
  let opened = ''
  const stopOpen = store.on('reviewer_input_open', (id) => {
    opened = id
  })
  card.querySelectorAll<HTMLButtonElement>('.reviewer-input-origin')[1]?.click()
  assert.equal(opened, 'saved-question-call:question:1')
  const view = mountReviewerInput(store, createFakeApi())
  view.sync()
  assert.equal(view.toggle.textContent, '2 questions')
  view.open('saved-question-call:question:0')
  assert.match(view.panel.textContent, /Agent suggests: Preview — It is experimental\./)
  let target: [string, string] | null = null
  const stopJump = store.on('reviewer_input_jump', (mid, id) => {
    target = [mid, id]
  })
  view.panel.querySelector<HTMLButtonElement>('.reviewer-input-origin')?.click()
  assert.deepEqual(target, ['saved-question-message', 'saved-question-call'])
  setReviewerInputAnswer(store, threadId, {
    id: 'saved-question-call:question:0',
    text: 'Preview',
    answeredAt: 2,
    messageId: 'answer-1',
  })
  view.sync()
  assert.equal(view.toggle.textContent, '1 question')
  assert.equal(view.panel.querySelectorAll('.reviewer-input-item').length, 1)
  const updated = createReviewerInputToolCard(call, store)
  assert.ok(updated)
  assert.match(updated.textContent, /Your answer: Preview/)
  assert.equal(updated.querySelectorAll('.reviewer-input-origin').length, 1)
  stopOpen()
  stopJump()
})
