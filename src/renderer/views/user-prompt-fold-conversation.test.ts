import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`).join('\n')
}

function mountWithUserMessage(content: string): void {
  const store = createStore()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', content)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, createFakeApi())
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('user prompt mid-fold in conversation', () => {
  it('leaves short prompts unfolded', () => {
    mountWithUserMessage(linesOf(10))
    const text = document.querySelector('.msg-user .message-text')
    assert.ok(text)
    assert.equal(text.classList.contains('msg-user-fold'), false)
    assert.equal(text.querySelector('.msg-user-fold-toggle'), null)
  })

  it('folds prompts over 10 lines with head, tail, and toggle', () => {
    mountWithUserMessage(`${linesOf(11)}\nWhat should we do next?`)
    const text = document.querySelector('.msg-user .message-text')
    assert.ok(text)
    assert.ok(text.classList.contains('msg-user-fold'))
    assert.equal(text.classList.contains('is-expanded'), false)
    assert.match(text.querySelector('.msg-user-fold-head')?.textContent ?? '', /line 1/)
    assert.match(
      text.querySelector('.msg-user-fold-tail')?.textContent ?? '',
      /What should we do next/,
    )
    const toggle = text.querySelector<HTMLButtonElement>('.msg-user-fold-toggle')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.match(text.querySelector('.msg-user-fold-label')?.textContent ?? '', /lines hidden/)

    toggle.click()
    assert.ok(text.classList.contains('is-expanded'))
    assert.equal(text.querySelector('.msg-user-fold-label')?.textContent, 'collapse')
  })
})
