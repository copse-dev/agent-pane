import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread, getThreadById, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { answerReviewerInput } from './reviewer-input.ts'
import { drainMessageQueue } from './message-queue.ts'

test('an answer is saved once and waits for the active run to finish', () => {
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
  assert.equal(answerReviewerInput(store, api, threadId, 'request-1', 'Wrap to two lines'), true)
  assert.equal(answerReviewerInput(store, api, threadId, 'request-1', 'Truncate'), false)
  assert.equal(runs.length, 0)
  const pending = getThreadById(store, threadId)
  assert.ok(pending)
  assert.equal(pending.reviewerInputAnswers?.[0]?.text, 'Wrap to two lines')
  assert.equal(pending.pendingMessages?.length, 1)
  assert.ok(pending.currentEpoch)
  assert.match(pending.messages.at(-1)?.content ?? '', /Answer to your review question/)

  setThreadStatus(store, threadId, 'idle')
  drainMessageQueue(store, api, threadId)
  assert.equal(runs.length, 1)
  assert.match(runs[0] ?? '', /Wrap to two lines/)
})
