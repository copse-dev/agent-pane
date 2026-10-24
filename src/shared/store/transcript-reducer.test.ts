import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from './store.ts'
import { getThreadById } from './thread-helpers.ts'
import { createTranscriptReducer } from './transcript-reducer.ts'
import type { Message, StreamChunk } from '@shared/types'
import {
  comparable,
  humanPrompt,
  recordedTurn,
  threadWith,
} from './transcript-stream.test-support.ts'

function seeded(): AppStore {
  return createStore({
    threads: [threadWith('t1', [humanPrompt('u1', 'What does the plan say?')])],
    activeThreadId: 't1',
  })
}

function messagesOf(store: AppStore): Message[] {
  return getThreadById(store, 't1')?.messages ?? []
}

/**
 * Main reduces the stream minting ids; the window reduces the same chunks
 * taking the ids main stamped on each one. This is the L1 test-plan property:
 * the two copies of a transcript are the same messages.
 */
function reduceBoth(chunks: readonly StreamChunk[]): { main: AppStore; window: AppStore } {
  const main = seeded()
  const window = seeded()
  let minted = 0
  let created: string[] = []
  const mainReducer = createTranscriptReducer(main, {
    createMessageId: () => {
      minted += 1
      const id = `main-${String(minted)}`
      created.push(id)
      return id
    },
  })
  let stamped: string[] = []
  const windowReducer = createTranscriptReducer(window, {
    createMessageId: () => stamped.shift(),
  })
  for (const chunk of chunks) {
    created = []
    mainReducer.apply('t1', chunk)
    stamped = [...created]
    windowReducer.apply('t1', chunk)
    assert.deepEqual(stamped, [], `the window used every id main stamped on ${chunk.type}`)
  }
  return { main, window }
}

test('main and the window reduce a recorded turn to the same messages', () => {
  const { main, window } = reduceBoth(recordedTurn())

  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  // The bubble boundaries the renderer has always drawn: the prompt, the step
  // that called the tool, and the answer after the tool result.
  assert.deepEqual(
    messagesOf(main).map((message) => [message.id, message.role]),
    [
      ['u1', 'user'],
      ['main-1', 'assistant'],
      ['main-2', 'assistant'],
    ],
  )
  const step = messagesOf(main).at(1)
  const answer = messagesOf(main).at(2)
  assert.equal(step?.content, 'Checking the plan before answering.')
  assert.equal(step.toolCalls.at(0)?.status, 'done')
  assert.equal(step.requestedModel, 'auto:fast')
  assert.equal(step.model, 'openai:gpt-5.5')
  assert.equal(answer?.content, 'The plan has one step: ship it. Done.')
  assert.equal(answer.turnOutcome?.status, 'completed')
  assert.equal(getThreadById(main, 't1')?.status, 'idle')
  assert.deepEqual(getThreadById(main, 't1')?.usage, getThreadById(window, 't1')?.usage)
  assert.deepEqual(getThreadById(main, 't1')?.todos, getThreadById(window, 't1')?.todos)
})

test('remote agent setup stages are status for the window, never transcript', () => {
  const setup: StreamChunk[] = [
    { type: 'agent_setup_progress', phase: 'start', label: 'Connecting to Dev…' },
    { type: 'agent_setup_progress', phase: 'setup', label: 'Installing pkg on Dev…' },
    { type: 'agent_setup_progress', phase: 'ready' },
  ]
  // Main runs without window hooks: the stages leave no message behind.
  const { main, window } = reduceBoth(setup)
  assert.deepEqual(
    messagesOf(main).map((message) => message.id),
    ['u1'],
  )
  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))

  // The window hears each stage's label, then `ready` hands the row back.
  const store = seeded()
  const calls: string[] = []
  const reducer = createTranscriptReducer(store, {
    setupProgress: (_threadId, label) => calls.push(`label:${label}`),
    activity: () => calls.push('activity'),
  })
  for (const chunk of setup) reducer.apply('t1', chunk)
  assert.deepEqual(calls, ['label:Connecting to Dev…', 'label:Installing pkg on Dev…', 'activity'])
  assert.deepEqual(
    messagesOf(store).map((message) => message.id),
    ['u1'],
  )
})

test('a machine turn prompt takes the id main stamped', () => {
  const { main, window } = reduceBoth([
    {
      type: 'machine_turn_start',
      content: 'Continue after the background build.',
      origin: { kind: 'machine', operationId: 'op-1' },
    },
    { type: 'text', text: 'Build passed.' },
    { type: 'done' },
  ])

  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  assert.deepEqual(
    messagesOf(window).map((message) => message.id),
    ['u1', 'main-1', 'main-2'],
  )
})

test('a user Stop is labelled by the hook, and an already-labelled outcome is kept', () => {
  const store = seeded()
  const reducer = createTranscriptReducer(store, { userAbort: () => 'send_now' })
  const cancelled = {
    status: 'cancelled' as const,
    stopReason: 'cancelled' as const,
    source: 'user' as const,
    executor: 'local' as const,
    provider: 'openai',
    model: 'openai:gpt-5.5',
    endedAt: 10,
  }
  reducer.apply('t1', { type: 'turn_outcome', outcome: cancelled })
  reducer.apply('t1', { type: 'done' })
  assert.equal(messagesOf(store).at(-1)?.turnOutcome?.userAbort, 'send_now')

  reducer.apply('t1', { type: 'turn_outcome', outcome: { ...cancelled, userAbort: 'stop' } })
  reducer.apply('t1', { type: 'done' })
  assert.equal(messagesOf(store).at(-1)?.turnOutcome?.userAbort, 'stop')
})
