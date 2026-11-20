import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread, getThreadById, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { answerReviewerInput } from './reviewer-input.ts'
import { drainMessageQueue, foldBackContinuationUsed } from './message-queue.ts'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

test('an answer is saved once and starts its human task only after the active run finishes', () => {
  const runs: string[] = []
  const base = createFakeApi()
  const api = {
    ...base,
    agent: {
      ...base.agent,
      run: (_projectId: string, _threadId: string, payload: string): Promise<void> => {
        runs.push(payload)
        return Promise.resolve()
      },
    },
  } satisfies ApiClient
  const store = createStore({ activeProjectId: 'project-1', workspaceRoot: '/repo' })
  const threadId = createThread(store)
  store.setState({
    threads: store.getState().threads.map((thread) =>
      thread.id !== threadId
        ? thread
        : {
            ...thread,
            messages: [
              {
                id: 'm1',
                role: 'assistant' as const,
                content: 'I need a decision.',
                createdAt: 1,
                toolCalls: [
                  {
                    id: 'request-1',
                    name: 'request_review_input',
                    status: 'done' as const,
                    result: 'Saved',
                    args: { question: 'Wrap?', context: 'The title clips.' },
                  },
                ],
              },
            ],
          },
    ),
  })
  setThreadStatus(store, threadId, 'running')
  store.setState({
    threads: store
      .getState()
      .threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, currentEpoch: 'active-tree', continuationUsed: 3 }
          : thread,
      ),
  })
  assert.equal(answerReviewerInput(store, api, threadId, 'request-1', 'Wrap to two lines'), true)
  assert.equal(answerReviewerInput(store, api, threadId, 'request-1', 'Truncate'), false)
  assert.equal(runs.length, 0)
  const pending = getThreadById(store, threadId)
  assert.ok(pending)
  assert.equal(pending.reviewerInputAnswers?.[0]?.text, 'Wrap to two lines')
  assert.equal(pending.pendingMessages?.length, 1)
  assert.equal(pending.currentEpoch, 'active-tree')
  assert.equal(pending.continuationUsed, 3)
  assert.match(pending.messages.at(-1)?.content ?? '', /Answer to your review question/)

  setThreadStatus(store, threadId, 'idle')
  drainMessageQueue(store, api, threadId)
  assert.equal(runs.length, 1)
  assert.match(runs[0] ?? '', /Wrap to two lines/)
  const dispatched = getThreadById(store, threadId)
  assert.ok(dispatched?.currentEpoch)
  assert.notEqual(dispatched.currentEpoch, 'active-tree')
  assert.equal(dispatched.continuationUsed, 0)
  const payload = expectRecord(parseJsonUnknown(runs[0] ?? ''))
  assert.equal(payload['turnTreeId'], dispatched.currentEpoch)
  assert.equal(payload['continuationBudgetUsed'], 0)
  foldBackContinuationUsed(store, threadId, 'active-tree', 4)
  assert.equal(getThreadById(store, threadId)?.continuationUsed, 0)
})

test('an answer submitted at idle starts a fresh human turn tree', () => {
  const store = createStore({ activeProjectId: 'project-1', workspaceRoot: '/repo' })
  const threadId = createThread(store)
  store.setState({
    threads: store.getState().threads.map((thread) =>
      thread.id !== threadId
        ? thread
        : {
            ...thread,
            currentEpoch: 'finished-tree',
            continuationUsed: 3,
            messages: [
              {
                id: 'm1',
                role: 'assistant' as const,
                content: 'I need a decision.',
                createdAt: 1,
                toolCalls: [
                  {
                    id: 'request-1',
                    name: 'request_review_input',
                    status: 'done' as const,
                    result: 'Saved',
                    args: { question: 'Wrap?', context: 'The title clips.' },
                  },
                ],
              },
            ],
          },
    ),
  })

  assert.equal(
    answerReviewerInput(store, createFakeApi(), threadId, 'request-1', 'Wrap to two lines'),
    true,
  )
  const answered = getThreadById(store, threadId)
  assert.ok(answered)
  assert.notEqual(answered.currentEpoch, 'finished-tree')
  assert.ok(answered.currentEpoch)
  assert.equal(answered.continuationUsed, 0)
})
