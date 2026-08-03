import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { bindChatComposerLayout } from './chat-layout.ts'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
})

function emptyThread(): Thread {
  return {
    id: 'thread-1',
    title: 'Demo thread',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function mountLayout(): HTMLElement {
  const pane = document.createElement('main')
  pane.id = 'pane-chat'
  const conversation = document.createElement('section')
  conversation.id = 'conversation'
  const input = document.createElement('div')
  input.id = 'input-bar'
  const composer = document.createElement('div')
  composer.className = 'prompt-input'
  input.append(composer)
  pane.append(conversation, input)
  document.body.append(pane)
  return composer
}

afterEach(() => {
  document.documentElement.removeAttribute('data-demo-embedded')
  document.body.replaceChildren()
})

describe('bindChatComposerLayout', () => {
  it('does not focus the empty composer in an embedded demo', () => {
    document.documentElement.dataset['demoEmbedded'] = 'on'
    const composer = mountLayout()
    let focusCount = 0
    composer.focus = (): void => {
      focusCount += 1
    }
    const store = createStore({
      activeThreadId: 'thread-1',
      threads: [emptyThread()],
    })

    const unbind = bindChatComposerLayout(store)

    assert.equal(focusCount, 0)
    unbind()
  })
})
