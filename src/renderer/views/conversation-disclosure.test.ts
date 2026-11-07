import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  setThreadStatus,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// The conversation view renders disclosure state from its disclosure model
// (disclosure-model.ts), not from the previous DOM. These tests drive the
// mounted view through tool-status churn and full rebuilds and assert that an
// explicit user choice is what the reader keeps seeing.

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
    } satisfies ApiClient
  })()
}

function mount(): { store: ReturnType<typeof createStore>; threadId: string; messageId: string } {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'assistant', '')
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, threadId, messageId }
}

function shell(id: string): Parameters<typeof addToolCall>[2] {
  return { id, name: 'run_shell', args: { command: 'npm test' }, status: 'running', result: null }
}

function toggle(card: HTMLDetailsElement): void {
  qsRequired(card, ':scope > summary').click()
}

/** Rebuild the whole transcript, as a thread switch away and back does. */
function rebuild(store: ReturnType<typeof createStore>, threadId: string): void {
  createThread(store)
  store.setState({ activeThreadId: threadId })
  store.emit('threads_changed')
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('conversation disclosure state (component)', () => {
  it('keeps a user-closed running card closed through running → done → running', async () => {
    const { store, messageId } = mount()
    addToolCall(store, messageId, shell('tc-1'))
    const card = qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]')
    await delay(350)
    assert.equal(card.open, true, 'long-running work should reveal once')
    toggle(card)
    assert.equal(card.open, false)

    updateToolCall(store, messageId, 'tc-1', { status: 'done', result: 'ok' })
    assert.equal(card.open, false, 'completion reopened a user-closed card')
    updateToolCall(store, messageId, 'tc-1', { status: 'running', result: null })
    await delay(350)
    assert.equal(card.open, false, 'a new running phase reopened a user-closed card')
  })

  it('keeps a user-closed running card closed when the transcript is rebuilt', async () => {
    const { store, threadId, messageId } = mount()
    addToolCall(store, messageId, shell('tc-1'))
    await delay(350)
    toggle(qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]'))

    rebuild(store, threadId)
    const restored = qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]')
    assert.equal(restored.open, false, 'refresh reopened a user-closed running card')
    await delay(350)
    assert.equal(restored.open, false, 'the reveal timer reopened a user-closed card')
  })

  it('keeps a user-opened card open through running → done → running and a rebuild', async () => {
    const { store, threadId, messageId } = mount()
    addToolCall(store, messageId, shell('tc-1'))
    const card = qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]')
    assert.equal(card.open, false, 'details reveal only after the delay')
    toggle(card)
    assert.equal(card.open, true)

    updateToolCall(store, messageId, 'tc-1', { status: 'done', result: 'ok' })
    updateToolCall(store, messageId, 'tc-1', { status: 'running', result: null })
    updateToolCall(store, messageId, 'tc-1', { status: 'done', result: 'ok' })
    setThreadStatus(store, threadId, 'idle')
    await delay(1_100)
    assert.equal(card.open, true, 'status churn or compaction closed a user-opened card')

    rebuild(store, threadId)
    assert.equal(
      qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]').open,
      true,
      'refresh lost the user-open choice',
    )
  })

  it('keeps a user-opened live rollup open while its tools churn', async () => {
    const { store, threadId, messageId } = mount()
    setThreadStatus(store, threadId, 'running')
    addToolCall(store, messageId, shell('tc-1'))
    const rollup = qsRequired<HTMLDetailsElement>(document, '.tool-card-rollup')
    toggle(rollup)
    assert.equal(rollup.open, true)

    updateToolCall(store, messageId, 'tc-1', { status: 'done', result: 'ok' })
    addToolCall(store, messageId, shell('tc-2'))
    updateToolCall(store, messageId, 'tc-2', { status: 'done', result: 'ok' })
    setThreadStatus(store, threadId, 'idle')
    await delay(1_100)
    assert.strictEqual(document.querySelector('.tool-card-rollup'), rollup)
    assert.equal(rollup.open, true, 'the rollup lost its user-open choice')
  })

  // The run goes live before the reveal delay elapses, so the next refresh
  // absorbs the still-running card into the live rollup: directly as a nested
  // card, or as an entry of a group formed with a like sibling.
  const absorptions: [shape: string, sibling: Parameters<typeof addToolCall>[2]][] = [
    ['a nested card', { ...shell('tc-2'), name: 'read_file', args: { path: 'a.md' } }],
    ['a group entry', shell('tc-2')],
  ]
  for (const [shape, sibling] of absorptions) {
    it(`does not pop open a running card absorbed into a rollup as ${shape}`, async () => {
      const { store, threadId, messageId } = mount()
      addToolCall(store, messageId, shell('tc-1'))
      const standalone = qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]')
      assert.equal(standalone.closest('.tool-card-rollup'), null, 'expected a standalone card')

      setThreadStatus(store, threadId, 'running')
      addToolCall(store, messageId, sibling)
      const rollup = qsRequired<HTMLDetailsElement>(document, '.tool-card-rollup')
      const nested = qsRequired<HTMLDetailsElement>(rollup, '[data-tool-id="tc-1"]')
      assert.equal(nested.classList.contains('tool-group-item'), shape === 'a group entry')

      await delay(350)
      assert.equal(nested.open, false, 'the absorbed card popped open after the reveal delay')
      assert.equal(rollup.open, false, 'background activity in a rollup stays quiet')
    })
  }

  it('keeps a user-opened group entry open while a sibling churns', () => {
    const { store, messageId } = mount()
    for (const id of ['tc-a', 'tc-b']) {
      addToolCall(store, messageId, {
        id,
        name: 'read_file',
        args: { path: `${id}.md` },
        status: 'done',
        result: 'text',
      })
    }
    const entry = qsRequired<HTMLDetailsElement>(document, '.tool-group-item[data-tool-id="tc-a"]')
    toggle(entry)
    assert.equal(entry.open, true)
    updateToolCall(store, messageId, 'tc-b', { status: 'running', result: null })
    updateToolCall(store, messageId, 'tc-b', { status: 'done', result: 'changed' })
    assert.equal(
      qsRequired<HTMLDetailsElement>(document, '.tool-group-item[data-tool-id="tc-a"]').open,
      true,
      'sibling churn closed a user-opened group entry',
    )
  })

  it('keeps a failed card open until the user closes it', () => {
    const { store, threadId, messageId } = mount()
    addToolCall(store, messageId, shell('tc-1'))
    updateToolCall(store, messageId, 'tc-1', { status: 'error', result: 'Error: exit 1' })
    const card = qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]')
    assert.equal(card.open, true, 'a failure should be visible without a click')
    toggle(card)
    rebuild(store, threadId)
    assert.equal(qsRequired<HTMLDetailsElement>(document, '[data-tool-id="tc-1"]').open, false)
  })
})
