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
  it('shows the Activity home for an empty thread and hands the pane back with the first message', () => {
    mountLayout()
    const store = createStore({ activeThreadId: 'thread-1', threads: [emptyThread()] })
    const shown: boolean[] = []

    const unbind = bindChatComposerLayout(store, (value) => {
      shown.push(value)
    })
    const pane = document.getElementById('pane-chat')
    assert.ok(pane?.classList.contains('is-activity-home'))
    assert.equal(shown.at(-1), true)

    store.setState({
      threads: [
        {
          ...emptyThread(),
          messages: [{ id: 'm1', role: 'user', content: 'hi', toolCalls: [], createdAt: 2 }],
        },
      ],
    })
    store.emit('message_added', 'thread-1', 'm1')
    assert.equal(pane?.classList.contains('is-activity-home'), false)
    assert.equal(shown.at(-1), false)
    unbind()
  })

  it('does not treat a thread that still has to load as empty', () => {
    mountLayout()
    const store = createStore({
      activeThreadId: 'thread-1',
      threads: [{ ...emptyThread(), messagesLoaded: false }],
    })
    const shown: boolean[] = []

    const unbind = bindChatComposerLayout(store, (value) => {
      shown.push(value)
    })

    assert.equal(
      document.getElementById('pane-chat')?.classList.contains('is-activity-home'),
      false,
    )
    assert.equal(shown.at(-1), false)
    unbind()
  })

  it('focuses the composer once per empty thread, not on every store event', () => {
    const composer = mountLayout()
    let focusCount = 0
    composer.focus = (): void => {
      focusCount += 1
    }
    const store = createStore({ activeThreadId: 'thread-1', threads: [emptyThread()] })

    const unbind = bindChatComposerLayout(store)
    assert.equal(focusCount, 1)
    store.emit('threads_changed')
    store.emit('threads_changed')
    assert.equal(focusCount, 1, 'a re-focus would pull the caret out of the Activity list')

    store.setState({
      activeThreadId: 'thread-2',
      threads: [emptyThread(), { ...emptyThread(), id: 'thread-2' }],
    })
    store.emit('threads_changed')
    assert.equal(focusCount, 2, 'a different empty thread gets the composer')
    unbind()
  })
})
