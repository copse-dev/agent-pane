import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { Message } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountReviewerInput } from './reviewer-input.ts'

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
  unsubscribe()
  view.toggle.remove()
  view.panel.remove()
})
