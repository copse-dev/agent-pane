import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { Thread } from '@shared/types'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from './message-queue.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { lastResendableMessage, resendLastMessage } from './resend-message.ts'

function createProjectStore(): ReturnType<typeof createStore> {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  return store
}

function parsePayload(json: string): AgentRunPayload {
  const parsed = safeJsonParse<AgentRunPayload>(json)
  if (!parsed) throw new Error('expected a JSON run payload')
  return parsed
}

/** Records every dispatched run; the rest of the surface is the demo double. */
function fakeApi(): { api: ApiClient; runs: Array<[string, AgentRunPayload]> } {
  const runs: Array<[string, AgentRunPayload]> = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      run: (_projectId: string, threadId: string, payload: string) => {
        runs.push([threadId, parsePayload(payload)])
        return Promise.resolve()
      },
    },
  }
  return { api, runs }
}

function getThread(store: ReturnType<typeof createStore>, threadId: string): Thread {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  return thread
}

test('resends the last user prompt as a new turn, leaving history intact', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Fix the login bug')
  addMessage(store, threadId, 'assistant', 'I looked at the wrong file.')

  const result = resendLastMessage(store, api, threadId)

  assert.ok(result)
  assert.equal(result.queued, false)
  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.messages.map((m) => m.content),
    ['Fix the login bug', 'I looked at the wrong file.', 'Fix the login bug'],
  )
  // A fresh bubble, not a mutation of the original.
  assert.notEqual(result.messageId, thread.messages[0]?.id)
  assert.equal(thread.status, 'running')
  assert.deepEqual(runs[0]?.[1].content, 'Fix the login bug')
})

test('picks the most recent prompt when the thread has several', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'First')
  addMessage(store, threadId, 'assistant', 'Answer')
  addMessage(store, threadId, 'user', 'Second')
  addMessage(store, threadId, 'assistant', 'Another answer')

  resendLastMessage(store, api, threadId)

  assert.deepEqual(runs[0]?.[1].content, 'Second')
})

test('queues the resend behind a running turn instead of interrupting it', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Fix the login bug')
  setThreadStatus(store, threadId, 'running')

  const result = resendLastMessage(store, api, threadId)

  assert.equal(result?.queued, true)
  assert.equal(runs.length, 0)
  const pending = getThread(store, threadId).pendingMessages ?? []
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.messageId, result.messageId)
})

test('ignores a queued follow-up — it has not been sent yet', () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Already sent')
  setThreadStatus(store, threadId, 'running')
  const queuedId = addMessage(store, threadId, 'user', 'Still queued')
  enqueueUserMessage(store, threadId, {
    messageId: queuedId,
    payload: { content: 'Still queued' },
    createdAt: 1,
  })

  assert.equal(lastResendableMessage(getThread(store, threadId))?.content, 'Already sent')
})

test('carries the prompt images and the thread working context', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  store.setState({
    threads: store.getState().threads.map((t) =>
      t.id !== threadId
        ? t
        : {
            ...t,
            workingBrief: 'Ship the login fix',
            todos: [{ id: 't1', content: 'Reproduce', status: 'pending' as const }],
          },
    ),
  })
  addMessage(store, threadId, 'user', 'What is wrong here?', ['data:image/png;base64,abc'])

  const result = resendLastMessage(store, api, threadId)

  assert.equal(result?.droppedAttachments, false)
  const payload = runs[0]?.[1]
  assert.deepEqual(payload?.content, [
    { type: 'image', dataUrl: 'data:image/png;base64,abc' },
    { type: 'text', text: 'What is wrong here?' },
  ])
  assert.equal(payload.workingBrief, 'Ship the login fix')
  assert.deepEqual(payload.priorTodos, [{ id: 't1', content: 'Reproduce', status: 'pending' }])
  const resent = getThread(store, threadId).messages.at(-1)
  assert.deepEqual(resent?.images, ['data:image/png;base64,abc'])
})

test('strips paste placeholders and reports the attachments it cannot rebuild', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Look at ￼ and fix it', undefined, [
    { kind: 'paste', label: 'pasted log' },
    { kind: 'file', label: 'login.ts' },
  ])

  const result = resendLastMessage(store, api, threadId)

  assert.equal(result?.droppedAttachments, true)
  assert.deepEqual(runs[0]?.[1].content, 'Look at and fix it')
  // The resent bubble makes no claim to attachments the payload no longer has.
  const resent = getThread(store, threadId).messages.at(-1)
  assert.equal(resent?.attachments, undefined)
  assert.equal(resent?.content, 'Look at and fix it')
})

test('does nothing when the thread has no prompt to repeat', () => {
  const store = createProjectStore()
  const { api, runs } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'assistant', 'Anything I can help with?')

  assert.equal(resendLastMessage(store, api, threadId), null)
  assert.equal(resendLastMessage(store, api, 'no-such-thread'), null)
  assert.equal(runs.length, 0)
})

test('starts a fresh turn tree, so late hook output from the last turn is stale', () => {
  const store = createProjectStore()
  const { api } = fakeApi()
  const threadId = createThread(store)
  store.setState({
    threads: store
      .getState()
      .threads.map((t) =>
        t.id !== threadId ? t : { ...t, currentEpoch: 'epoch-1', continuationUsed: 3 },
      ),
  })
  addMessage(store, threadId, 'user', 'Try again')

  resendLastMessage(store, api, threadId)

  const thread = getThread(store, threadId)
  assert.notEqual(thread.currentEpoch, 'epoch-1')
  assert.equal(thread.continuationUsed, 0)
})
