import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, sameItems } from './store.ts'
import {
  createThread,
  addMessage,
  appendToken,
  addToolCall,
  updateToolCall,
} from './thread-helpers.ts'

describe('store', () => {
  it('starts with the dark theme pinned', () => {
    const store = createStore()
    assert.equal(store.getState().theme, 'dark')
    assert.equal(store.getState().themePreference, 'dark')
  })

  it('fires message_added when a message is added', () => {
    const store = createStore()
    const threadId = createThread(store)
    let fired = false
    store.on('message_added', () => {
      fired = true
    })
    addMessage(store, threadId, 'user', 'hello')
    assert.ok(fired)
  })

  it('fires message_token with appended text', () => {
    const store = createStore()
    const threadId = createThread(store)
    const msgId = addMessage(store, threadId, 'assistant')
    const tokens: string[] = []
    store.on('message_token', (id, text) => {
      if (id === msgId) tokens.push(text)
    })
    appendToken(store, msgId, 'foo')
    appendToken(store, msgId, 'bar')
    assert.deepEqual(tokens, ['foo', 'bar'])
  })

  it('preserves newline-only tokens in message content', () => {
    const store = createStore()
    const threadId = createThread(store)
    const msgId = addMessage(store, threadId, 'assistant')
    appendToken(store, msgId, '## Title')
    appendToken(store, msgId, '\n')
    appendToken(store, msgId, '- item')
    const thread = store.getState().threads[0]
    assert.ok(thread)
    const msg = thread.messages[0]
    assert.ok(msg)
    assert.equal(msg.content, '## Title\n- item')
  })

  it('unsubscribe stops receiving events', () => {
    const store = createStore()
    let count = 0
    const unsub = store.on('threads_changed', () => {
      count++
    })
    store.emit('threads_changed')
    unsub()
    store.emit('threads_changed')
    assert.equal(count, 1)
  })

  it('tool_call_updated fires after updateToolCall', () => {
    const store = createStore()
    const threadId = createThread(store)
    const msgId = addMessage(store, threadId, 'assistant')
    addToolCall(store, msgId, {
      id: 'tc1',
      name: 'read_file',
      args: {},
      status: 'running',
      result: null,
    })
    let updatedId = ''
    store.on('tool_call_updated', (_, tcId) => {
      updatedId = tcId
    })
    updateToolCall(store, msgId, 'tc1', { status: 'done', result: 'file content' })
    assert.equal(updatedId, 'tc1')
  })
})

describe('store.select', () => {
  it('notifies with the next and previous value when the selected state changes', () => {
    const store = createStore()
    const calls: [boolean, boolean][] = []
    store.select(
      (s) => s.projectsPaneOpen,
      (next, prev) => calls.push([next, prev]),
    )
    store.setState({ projectsPaneOpen: false })
    assert.deepEqual(calls, [[false, true]])
  })

  it('does not notify on subscribe or when the selected value is unchanged', () => {
    const store = createStore()
    let count = 0
    store.select(
      (s) => s.rightPanelMode,
      () => count++,
    )
    store.setState({ filesPaneOpen: true })
    store.setState({ rightPanelMode: 'explorer' })
    assert.equal(count, 0)
  })

  it('uses the supplied equality to decide whether a derived value changed', () => {
    const store = createStore({ rightPanelMode: 'browser' })
    const seen: string[][] = []
    store.select(
      (s) => [s.rightPanelMode, String(s.filesPaneOpen)],
      (next) => seen.push(next),
      sameItems,
    )
    // A fresh array every time: without the equality this would always fire.
    store.setState({ theme: 'light' })
    store.setState({ filesPaneOpen: true })
    assert.deepEqual(seen, [['browser', 'true']])
  })

  it('sameItems compares tuples item by item', () => {
    const diff = { path: 'a.ts' }
    assert.equal(sameItems(['p', diff], ['p', diff]), true)
    assert.equal(sameItems(['p', diff], ['p', { path: 'a.ts' }]), false)
    assert.equal(sameItems(['p'], ['p', null]), false)
    assert.equal(sameItems([Number.NaN], [Number.NaN]), true)
  })

  it('stops notifying after unsubscribe', () => {
    const store = createStore()
    let count = 0
    const unsub = store.select(
      (s) => s.activeThreadId,
      () => count++,
    )
    store.setState({ activeThreadId: 'a' })
    unsub()
    store.setState({ activeThreadId: 'b' })
    assert.equal(count, 1)
  })

  it('notifies every subscriber, and one unsubscribing mid-notify does not skip the rest', () => {
    const store = createStore()
    const order: string[] = []
    const unsubFirst = store.select(
      (s) => s.filesPaneOpen,
      () => {
        order.push('first')
        unsubSecond()
      },
    )
    const unsubSecond = store.select(
      (s) => s.filesPaneOpen,
      () => order.push('second'),
    )
    store.select(
      (s) => s.filesPaneOpen,
      () => order.push('third'),
    )
    store.setState({ filesPaneOpen: true })
    assert.deepEqual(order, ['first', 'third'])
    unsubFirst()
    store.setState({ filesPaneOpen: false })
    assert.deepEqual(order, ['first', 'third', 'third'])
  })

  it('notifies once when a listener writes state that another subscriber reads', () => {
    const store = createStore()
    const seen: (string | null)[] = []
    store.select(
      (s) => s.activeProjectId,
      (projectId) => {
        store.setState({ activeThreadId: projectId ? `${projectId}-thread` : null })
      },
    )
    store.select(
      (s) => s.activeThreadId,
      (threadId) => seen.push(threadId),
    )
    store.setState({ activeProjectId: 'p1' })
    assert.deepEqual(seen, ['p1-thread'])
    assert.equal(store.getState().activeThreadId, 'p1-thread')
  })
})
