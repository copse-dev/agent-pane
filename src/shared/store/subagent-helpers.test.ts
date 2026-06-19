import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
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

    const tc = store
      .getState()
      .threads[0]!.messages.find((m) => m.id === msgId)!
      .toolCalls.find((t) => t.id === 'tc-explore')!

    assert.equal(tc.subagent?.status, 'done')
    assert.equal(tc.subagent?.summary, 'Auth lives in auth.ts')
    assert.equal(tc.subagent?.messages[0]?.content, 'Reading files…')
    assert.equal(tc.subagent?.messages[0]?.toolCalls[0]?.result, 'export function auth() {}')
  })
})
