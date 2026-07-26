import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { createStore } from './store.ts'
import type { AppStore } from './store.ts'
import type { Thread } from '@shared/types'
import { createThread, addMessage, addToolCall } from './thread-helpers.ts'
import {
  initSubagent,
  appendSubagentText,
  addSubagentToolCall,
  updateSubagentToolCall,
  finishSubagent,
} from './subagent-helpers.ts'

describe('subagent-helpers', () => {
  it('mutates subagent session on streaming chunks', () => {
    const store = createStore()
    const threadId = createThread(store)
    const msgId = addMessage(store, threadId, 'assistant')
    addToolCall(store, msgId, {
      id: 'tc-explore',
      name: 'explore',
      args: { query: 'find auth' },
      status: 'running',
      result: null,
    })

    initSubagent(store, msgId, 'tc-explore', {
      id: 'sub-1',
      kind: 'explore',
      status: 'running',
      prompt: 'find auth',
      summary: null,
      messages: [],
    })

    appendSubagentText(store, msgId, 'tc-explore', 'sub-msg-1', 'Reading files…')
    addSubagentToolCall(store, msgId, 'tc-explore', 'sub-msg-1', {
      id: 'inner-read',
      name: 'read_file',
      args: { path: 'auth.ts' },
      status: 'running',
      result: null,
    })
    updateSubagentToolCall(store, msgId, 'tc-explore', 'inner-read', {
      status: 'done',
      result: 'export function auth() {}',
    })
    finishSubagent(store, msgId, 'tc-explore', 'Auth lives in auth.ts', 'done')

    const thread = store.getState().threads[0]
    assert.ok(thread)
    const message = thread.messages.find((m) => m.id === msgId)
    assert.ok(message)
    const tc = message.toolCalls.find((t) => t.id === 'tc-explore')
    assert.ok(tc)
    const subagent = tc.subagent
    assert.ok(subagent)

    assert.equal(subagent.status, 'done')
    assert.equal(subagent.summary, 'Auth lives in auth.ts')
    assert.equal(at(subagent.messages, 0).content, 'Reading files…')
    assert.equal(at(subagent.messages, 0).toolCalls[0]?.result, 'export function auth() {}')
  })
})

describe('subagent stream updates avoid whole-history copies (#1155)', () => {
  const find = (store: AppStore, id: string): Thread => {
    const thread = store.getState().threads.find((t) => t.id === id)
    assert.ok(thread, `thread ${id} present`)
    return thread
  }

  // Two threads, each with an assistant message whose tool call owns a running
  // subagent session. addMessage prunes *other* blank threads on a thread's first
  // message, so each thread is messaged right after creation to keep both alive.
  function seedTwoSubagentThreads(store: AppStore): {
    a: string
    b: string
    aMsg: string
    bMsg: string
  } {
    const seed = (prompt: string): { threadId: string; msgId: string } => {
      const threadId = createThread(store)
      const msgId = addMessage(store, threadId, 'assistant')
      addToolCall(store, msgId, {
        id: `${prompt}-tc`,
        name: 'explore',
        args: {},
        status: 'running',
        result: null,
      })
      initSubagent(store, msgId, `${prompt}-tc`, {
        id: `${prompt}-sub`,
        kind: 'explore',
        status: 'running',
        prompt,
        summary: null,
        messages: [],
      })
      return { threadId, msgId }
    }
    const a = seed('a')
    const b = seed('b')
    return { a: a.threadId, b: b.threadId, aMsg: a.msgId, bMsg: b.msgId }
  }

  it('appendSubagentText clones only the owning thread, not unrelated history', () => {
    const store = createStore()
    const { a, b, aMsg } = seedTwoSubagentThreads(store)

    const aBefore = find(store, a)
    const bBefore = find(store, b)

    appendSubagentText(store, aMsg, 'a-tc', 'a-sub-msg', 'reading…')

    // Unrelated thread keeps its object identity — it was not cloned.
    assert.equal(find(store, b), bBefore)
    // Owning thread is a fresh object with a fresh messages array.
    const aAfter = find(store, a)
    assert.notEqual(aAfter, aBefore)
    assert.notEqual(aAfter.messages, aBefore.messages)
    // The update landed on the owning subagent session.
    const tc = at(aAfter.messages, 0).toolCalls.find((t) => t.id === 'a-tc')
    assert.ok(tc?.subagent)
    assert.equal(at(tc.subagent.messages, 0).content, 'reading…')
  })

  it('a burst of subagent chunks never clones the unrelated thread', () => {
    const store = createStore()
    const { b, aMsg } = seedTwoSubagentThreads(store)
    const bBefore = find(store, b)

    for (let i = 0; i < 20; i++) {
      appendSubagentText(store, aMsg, 'a-tc', 'a-sub-msg', `chunk ${String(i)} `)
    }

    assert.equal(find(store, b), bBefore)
  })

  it('addSubagentToolCall / finishSubagent leave the unrelated thread referentially stable', () => {
    const store = createStore()
    const { b, aMsg } = seedTwoSubagentThreads(store)
    const bBefore = find(store, b)

    addSubagentToolCall(store, aMsg, 'a-tc', 'a-sub-msg', {
      id: 'a-inner',
      name: 'read_file',
      args: {},
      status: 'running',
      result: null,
    })
    assert.equal(find(store, b), bBefore)

    updateSubagentToolCall(store, aMsg, 'a-tc', 'a-inner', { status: 'done', result: 'ok' })
    assert.equal(find(store, b), bBefore)

    finishSubagent(store, aMsg, 'a-tc', 'done', 'done')
    assert.equal(find(store, b), bBefore)
  })

  it('an unknown message id is a no-op (no thread churn)', () => {
    const store = createStore()
    const { a, b } = seedTwoSubagentThreads(store)
    const threadsBefore = store.getState().threads
    const aBefore = find(store, a)
    const bBefore = find(store, b)

    appendSubagentText(store, 'no-such-message', 'a-tc', 'x', 'ignored')

    // No owning thread found → no setState, so the whole threads array keeps identity.
    assert.equal(store.getState().threads, threadsBefore)
    assert.equal(find(store, a), aBefore)
    assert.equal(find(store, b), bBefore)
  })
})
