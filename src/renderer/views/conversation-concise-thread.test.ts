import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  setMessageTurnOutcome,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function fakeApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } satisfies ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

/** A capable-model turn: one working bubble with a tool call, then the summary. */
function seedCapableTurn(conciseThreadsEnabled: boolean): ReturnType<typeof createStore> {
  const store = createStore({ conciseThreadsEnabled })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Fix the footer')
  const working = addMessage(
    store,
    threadId,
    'assistant',
    'Reading the form.',
    undefined,
    undefined,
    {
      model: 'claude-opus-5-5',
    },
  )
  addToolCall(store, working, {
    id: 'read-1',
    name: 'read_file',
    args: { path: 'form.ts' },
    status: 'done',
    result: '',
  })
  addMessage(store, threadId, 'assistant', 'Save now stays pinned.', undefined, undefined, {
    model: 'claude-opus-5-5',
  })
  return store
}

function conciseClasses(): string[][] {
  return [...document.querySelectorAll<HTMLElement>('.msg-assistant')].map((msgEl) =>
    [...msgEl.classList].filter((name) => name.startsWith('msg-concise')),
  )
}

describe('concise thread view in the conversation', () => {
  it('renders a capable model in full while the setting is off', () => {
    const store = seedCapableTurn(false)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.deepEqual(conciseClasses(), [[], []])
  })

  it('applies the concise view when the setting is on', () => {
    const store = seedCapableTurn(true)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.deepEqual(conciseClasses(), [['msg-concise', 'msg-concise-steps'], ['msg-concise']])
  })

  it('re-applies to rendered messages when the setting flips', () => {
    const store = seedCapableTurn(false)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    store.setState({ conciseThreadsEnabled: true })
    store.emit('settings_changed')
    assert.deepEqual(conciseClasses(), [['msg-concise', 'msg-concise-steps'], ['msg-concise']])

    store.setState({ conciseThreadsEnabled: false })
    store.emit('settings_changed')
    assert.deepEqual(conciseClasses(), [[], []])
  })

  describe('Show steps footer', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const footers = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>('.messages-list > .concise-turn-footer'),
    ]

    async function mount(store: ReturnType<typeof createStore>): Promise<void> {
      const host = document.createElement('div')
      document.body.append(host)
      mountConversation(host, store, fakeApi())
      await flush()
    }

    it('sits after a finished concise turn and counts what the view hides', async () => {
      await mount(seedCapableTurn(true))

      const [footer] = footers()
      assert.equal(footers().length, 1)
      assert.equal(footer?.previousElementSibling, [...document.querySelectorAll('.msg')].at(-1))
      assert.match(footer?.textContent ?? '', /Show steps/)
      assert.match(footer?.textContent ?? '', /1 tool call\b/)
      assert.equal(footer?.querySelector('button')?.getAttribute('aria-expanded'), 'false')
    })

    it('shows what the hidden edits came to', async () => {
      const store = seedCapableTurn(true)
      const working = store.getState().threads[0]?.messages[1]?.id ?? ''
      addToolCall(store, working, {
        id: 'edit-1',
        name: 'str_replace',
        args: { path: 'form.ts' },
        status: 'done',
        result: '',
        editStats: { additions: 4, deletions: 2 },
      })
      await mount(store)

      assert.equal(footers()[0]?.querySelector('.concise-turn-edits')?.textContent, '+4−2')
    })

    it('opens just that turn in full and closes it again', async () => {
      await mount(seedCapableTurn(true))

      footers()[0]?.querySelector('button')?.click()
      await flush()
      assert.deepEqual(conciseClasses(), [[], []])
      assert.match(footers()[0]?.textContent ?? '', /Hide steps/)
      assert.equal(footers()[0]?.querySelector('button')?.getAttribute('aria-expanded'), 'true')

      footers()[0]?.querySelector('button')?.click()
      await flush()
      assert.deepEqual(conciseClasses(), [['msg-concise', 'msg-concise-steps'], ['msg-concise']])
      assert.match(footers()[0]?.textContent ?? '', /Show steps/)
    })

    it('keeps the toggle element, so keyboard focus survives opening a turn', async () => {
      await mount(seedCapableTurn(true))
      const button = footers()[0]?.querySelector('button')
      button?.click()
      await flush()
      assert.equal(footers()[0]?.querySelector('button'), button)
    })

    it('is absent with the setting off, and when the view hides nothing', async () => {
      await mount(seedCapableTurn(false))
      assert.equal(footers().length, 0)

      document.body.replaceChildren()
      const store = createStore({ conciseThreadsEnabled: true })
      const threadId = createThread(store)
      addMessage(store, threadId, 'user', 'Say hi')
      addMessage(store, threadId, 'assistant', 'Hi.', undefined, undefined, {
        model: 'claude-opus-5-5',
      })
      await mount(store)
      assert.equal(footers().length, 0)
    })

    it('waits for the running turn, which opens from the activity row, then appears', async () => {
      const store = seedCapableTurn(true)
      const threadId = store.getState().activeThreadId ?? ''
      setThreadStatus(store, threadId, 'running')
      await mount(store)
      assert.equal(footers().length, 0)

      setThreadStatus(store, threadId, 'idle')
      await flush()
      assert.equal(footers().length, 1)
    })

    it('says a Stop happened, since the card that said so is hidden', async () => {
      const store = createStore({ conciseThreadsEnabled: true })
      const threadId = createThread(store)
      addMessage(store, threadId, 'user', 'Fix the footer')
      const working = addMessage(store, threadId, 'assistant', '', undefined, undefined, {
        model: 'claude-opus-5-5',
      })
      addToolCall(store, working, {
        id: 'sh-1',
        name: 'run_shell',
        args: { command: 'pnpm test' },
        status: 'error',
        result: 'Interrupted',
      })
      setMessageTurnOutcome(store, threadId, working, {
        status: 'cancelled',
        stopReason: 'cancelled',
        source: 'user',
        executor: 'local',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        userAbort: 'stop',
        endedAt: 1,
      })
      await mount(store)

      assert.match(footers()[0]?.textContent ?? '', /Interrupted by you\./)
      assert.match(footers()[0]?.textContent ?? '', /Show steps/)
    })

    it('goes away when the setting turns off', async () => {
      const store = seedCapableTurn(true)
      await mount(store)
      assert.equal(footers().length, 1)

      store.setState({ conciseThreadsEnabled: false })
      store.emit('settings_changed')
      await flush()
      assert.equal(footers().length, 0)
    })
  })

  describe('model labels', () => {
    function seedModelSwitch(): ReturnType<typeof createStore> {
      const store = createStore({ conciseThreadsEnabled: true })
      const threadId = createThread(store)
      addMessage(store, threadId, 'user', 'Find it')
      addMessage(store, threadId, 'assistant', 'Searching.', undefined, undefined, {
        model: 'claude-haiku-4-5',
      })
      addMessage(store, threadId, 'assistant', 'Found it.', undefined, undefined, {
        model: 'claude-haiku-4-5',
      })
      addMessage(store, threadId, 'user', 'Now change it')
      const second = addMessage(store, threadId, 'assistant', 'Editing.', undefined, undefined, {
        model: 'claude-opus-5-5',
      })
      addToolCall(store, second, {
        id: 'edit-1',
        name: 'read_file',
        args: { path: 'a.ts' },
        status: 'done',
        result: '',
      })
      addMessage(store, threadId, 'assistant', 'Changed.', undefined, undefined, {
        model: 'claude-opus-5-5',
      })
      return store
    }

    it('puts a model switch’s label on the bubble the concise view paints', () => {
      const store = seedModelSwitch()
      const host = document.createElement('div')
      document.body.append(host)
      mountConversation(host, store, fakeApi())

      const labelled = [...document.querySelectorAll<HTMLElement>('.msg-assistant')].map(
        (msgEl) => msgEl.querySelector('.message-model')?.textContent ?? '',
      )
      // Haiku's turn renders in full, so its first bubble carries its label; Opus's
      // process bubble is hidden, so the label moves to its summary.
      assert.match(labelled[0] ?? '', /Haiku/)
      assert.equal(labelled[1], '')
      assert.equal(labelled[2], '')
      assert.match(labelled[3] ?? '', /Opus/)
    })
  })
})
