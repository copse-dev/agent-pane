import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  createThread,
  addMessage,
  appendToken,
  addToolCall,
  updateToolCall,
} from './thread-helpers.ts'

describe('store', () => {
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
