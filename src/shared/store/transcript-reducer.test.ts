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

test('steering separates the note from the tool step with matching main/window message IDs', () => {
  const { main, window } = reduceBoth([
    { type: 'steering_ready', runId: 'run' },
    { type: 'text', text: 'Reading the files.' },
    { type: 'steering_applied', messageId: 'correction', text: 'Keep the API.' },
    { type: 'text', text: 'The API is unchanged.' },
    { type: 'steering_ready', runId: null },
    { type: 'done' },
  ])
  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  assert.deepEqual(
    messagesOf(main).map((message) => [message.id, message.role]),
    [
      ['u1', 'user'],
      ['main-1', 'assistant'],
      ['correction', 'user'],
      ['main-2', 'assistant'],
    ],
  )
  assert.equal(getThreadById(main, 't1')?.nativeSteeringRunId, undefined)
  assert.equal(messagesOf(main).at(-1)?.content, 'The API is unchanged.')
})

for (const order of [
  ['u1', 'step', 'note', 'later'],
  ['u1', 'note', 'step', 'later'],
  ['u1', 'step', 'later'],
]) {
  test(`steering leaves later pending notes behind the completed boundary: ${order.join(', ')}`, () => {
    const messages: Message[] = order.map((id) => ({
      ...humanPrompt(id, id === 'note' ? 'Unreviewed original' : id),
      role: id === 'step' ? 'assistant' : 'user',
    }))
    const store = createStore({
      threads: [
        {
          ...threadWith('t1', messages),
          pendingMessages: ['note', 'later'].map((messageId) => ({
            messageId,
            payload: { content: messageId },
            createdAt: 20,
            autoDispatch: false,
          })),
        },
      ],
      activeThreadId: 't1',
    })
    const reducer = createTranscriptReducer(store)
    reducer.apply('t1', { type: 'steering_applied', messageId: 'note', text: 'Keep the API.' })
    assert.deepEqual(
      messagesOf(store).map((message) => message.id),
      ['u1', 'step', 'note', 'later'],
    )
    assert.equal(
      messagesOf(store).find((message) => message.id === 'note')?.content,
      'Keep the API.',
    )
    assert.deepEqual(
      getThreadById(store, 't1')?.pendingMessages?.map((item) => item.messageId),
      ['later'],
    )
    reducer.apply('t1', { type: 'steering_applied', messageId: 'later', text: 'later' })
    assert.deepEqual(
      messagesOf(store).map((message) => message.id),
      ['u1', 'step', 'note', 'later'],
    )
    assert.deepEqual(getThreadById(store, 't1')?.pendingMessages, [])
  })
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

test('ACP whole-message upserts replace only their external message id', () => {
  const { main, window } = reduceBoth([
    {
      type: 'acp_content',
      channel: 'message',
      messageId: 'm-1',
      content: { type: 'text', text: 'first draft' },
    },
    {
      type: 'acp_content',
      channel: 'message',
      messageId: 'm-2',
      content: { type: 'text', text: 'second stays' },
    },
    {
      type: 'acp_content_replace',
      channel: 'message',
      messageId: 'm-1',
      content: [
        { type: 'text', text: 'first final' },
        {
          type: 'image',
          dataUrl: 'data:image/png;base64,cGl4ZWxz',
          mimeType: 'image/png',
        },
      ],
    },
  ])

  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  const [, first, second] = messagesOf(main)
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.content, 'first final')
  assert.deepEqual(first.contentBlocks, [
    { type: 'image', dataUrl: 'data:image/png;base64,cGl4ZWxz', mimeType: 'image/png' },
  ])
  assert.equal(second.content, 'second stays')
})

test('ACP whole-thought upserts replace reasoning by external id', () => {
  const { main, window } = reduceBoth([
    {
      type: 'acp_content',
      channel: 'thought',
      messageId: 'thought-1',
      content: { type: 'text', text: 'draft reasoning' },
    },
    {
      type: 'acp_content_replace',
      channel: 'thought',
      messageId: 'thought-1',
      content: [{ type: 'text', text: 'final reasoning' }],
    },
  ])

  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  assert.equal(messagesOf(main).at(1)?.reasoning, 'final reasoning')
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

for (const hidden of [false, true]) {
  test(`a ${hidden ? 'hidden' : 'visible'} machine turn clears an earlier interruption`, () => {
    const interrupted = threadWith('t1', [humanPrompt('u1', 'Check the project.')])
    interrupted.status = 'idle'
    interrupted.interruptedTurnAt = 20
    const store = createStore({ threads: [interrupted], activeThreadId: 't1' })
    const reducer = createTranscriptReducer(store)

    reducer.apply('t1', {
      type: 'machine_turn_start',
      ...(hidden ? { hidden: true } : {}),
      content: 'The user accepted a.txt.',
      origin: { kind: 'machine', operationId: 'accept-1' },
    })
    assert.equal(getThreadById(store, 't1')?.status, 'running')
    assert.equal(getThreadById(store, 't1')?.interruptedTurnAt, undefined)
    assert.equal(
      messagesOf(store).filter((message) => message.role === 'user').length,
      hidden ? 1 : 2,
    )

    reducer.apply('t1', { type: 'text', text: 'The accepted change is verified.' })
    reducer.apply('t1', { type: 'done' })
    assert.equal(getThreadById(store, 't1')?.status, 'idle')
    assert.equal(getThreadById(store, 't1')?.interruptedTurnAt, undefined)
  })
}

test('an internal machine notification starts a turn without adding a chat prompt', () => {
  const store = seeded()
  let started = 0
  const reducer = createTranscriptReducer(store, {
    turnStarted: () => {
      started += 1
    },
  })
  reducer.apply('t1', {
    type: 'machine_turn_start',
    hidden: true,
    content: 'The user accepted a.txt.',
    origin: { kind: 'machine', operationId: 'accept-1' },
  })
  assert.equal(started, 1)
  assert.equal(getThreadById(store, 't1')?.status, 'running')
  assert.equal(messagesOf(store).length, 1)
  reducer.apply('t1', { type: 'done' })
  assert.equal(getThreadById(store, 't1')?.status, 'idle')
  assert.equal(messagesOf(store).length, 1)

  const { main, window } = reduceBoth([
    {
      type: 'machine_turn_start',
      hidden: true,
      content: 'The user accepted a.txt.',
      origin: { kind: 'machine', operationId: 'accept-1' },
    },
    { type: 'text', text: 'Validation passed.' },
    { type: 'done' },
  ])
  assert.deepEqual(comparable(messagesOf(window)), comparable(messagesOf(main)))
  assert.deepEqual(
    messagesOf(main).map((message) => message.role),
    ['user', 'assistant'],
  )
})

test('protected human entry replaces only its optimistic prompt with reviewed text', () => {
  const store = seeded()
  const optimistic = messagesOf(store)[0]
  assert.ok(optimistic)
  optimistic.attachments = [{ kind: 'file', label: 'stale.txt', content: 'pre-review bytes' }]
  const reducer = createTranscriptReducer(store)
  reducer.apply('t1', {
    type: 'protected_human_turn_start',
    messageId: 'u1',
    content: [
      { type: 'text', text: 'Reviewed exact prompt' },
      { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
    ],
  })

  assert.equal(messagesOf(store)[0]?.content, 'Reviewed exact prompt')
  assert.deepEqual(messagesOf(store)[0]?.images, ['data:image/png;base64,AA=='])
  assert.equal(messagesOf(store)[0]?.attachments, undefined)
  assert.equal(messagesOf(store).length, 1)
  assert.equal(getThreadById(store, 't1')?.status, 'running')
})

test('protected human entry preserves a verified unchanged optimistic display', () => {
  const store = seeded()
  const optimistic = messagesOf(store)[0]
  assert.ok(optimistic)
  optimistic.content = 'Compare \uFFFC with the proposal'
  optimistic.images = ['data:image/png;base64,AA==']
  optimistic.attachments = [{ kind: 'thread', label: 'Auth refactor plan' }]
  const reducer = createTranscriptReducer(store)
  reducer.apply('t1', {
    type: 'protected_human_turn_start',
    messageId: 'u1',
    content: [
      { type: 'text', text: 'Compare @Auth refactor plan with the proposal' },
      { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
    ],
    preserveOptimisticDisplay: true,
  })

  assert.equal(messagesOf(store)[0]?.content, 'Compare \uFFFC with the proposal')
  assert.deepEqual(messagesOf(store)[0]?.images, ['data:image/png;base64,AA=='])
  assert.deepEqual(messagesOf(store)[0]?.attachments, [
    { kind: 'thread', label: 'Auth refactor plan' },
  ])
  assert.equal(messagesOf(store).length, 1)
  assert.equal(getThreadById(store, 't1')?.status, 'running')
})

test('protected human entry keeps the accepted main identity when no optimistic prompt remains', () => {
  const store = seeded()
  const original = messagesOf(store)[0]
  assert.ok(original)
  const reducer = createTranscriptReducer(store)
  reducer.apply('t1', {
    type: 'protected_human_turn_start',
    messageId: 'accepted-after-retirement',
    content: 'Reviewed exact prompt',
  })

  assert.deepEqual(
    messagesOf(store).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    })),
    [
      { id: original.id, role: original.role, content: original.content },
      {
        id: 'accepted-after-retirement',
        role: 'user',
        content: 'Reviewed exact prompt',
      },
    ],
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

test('a command phase update lands on its card in main and the window alike', () => {
  const { main, window } = reduceBoth([
    { type: 'tool_call', toolCall: { id: 'sh1', name: 'run_shell', args: { command: 'ls' } } },
    {
      type: 'tool_call_update',
      toolCallId: 'sh1',
      commandPhase: { state: 'awaiting_approval', since: 2, launched: false },
    },
    {
      type: 'tool_call_update',
      toolCallId: 'sh1',
      commandPhase: { state: 'exited', since: 3, launched: true, exitCode: 2 },
    },
    { type: 'tool_result', toolCallId: 'sh1', result: 'Exited with code 2', isError: true },
  ])
  for (const store of [main, window]) {
    const call = messagesOf(store).at(-1)?.toolCalls.at(0)
    assert.equal(call?.status, 'error')
    assert.deepEqual(call.commandPhase, { state: 'exited', since: 3, launched: true, exitCode: 2 })
  }
})

test('a deferred tool result marks only its own card deferred', () => {
  const write = (id: string, path: string): StreamChunk => ({
    type: 'tool_call',
    toolCall: { id, name: 'write_file', args: { path } },
  })
  const { main, window } = reduceBoth([
    write('w1', 'packages/api/first.ts'),
    write('w2', 'README.md'),
    {
      type: 'tool_result',
      toolCallId: 'w1',
      result: 'Edit deferred…',
      isError: false,
      deferred: true,
    },
    { type: 'tool_result', toolCallId: 'w2', result: 'Applied edit.', isError: false },
  ])
  for (const store of [main, window]) {
    const [deferred, applied] = messagesOf(store).at(-1)?.toolCalls ?? []
    assert.equal(deferred?.status, 'done')
    assert.equal(deferred.deferred, true)
    assert.equal(applied?.deferred, undefined)
  }
})

for (const retryId of ['call_0', 'retry_1']) {
  test(`a performed retry ${retryId} has no stale deferred marker in main or the window`, () => {
    const write = (id: string): StreamChunk => ({
      type: 'tool_call',
      toolCall: { id, name: 'write_file', args: { path: 'packages/api/first.ts' } },
    })
    const { main, window } = reduceBoth([
      write('call_0'),
      {
        type: 'tool_result',
        toolCallId: 'call_0',
        result: 'Edit deferred.',
        isError: false,
        deferred: true,
      },
      { type: 'text', text: 'Retrying with the instructions.' },
      write(retryId),
      { type: 'tool_result', toolCallId: retryId, result: 'File written.', isError: false },
    ])
    for (const store of [main, window]) {
      const calls = messagesOf(store).flatMap((message) => message.toolCalls)
      const applied = calls.find((call) => call.result === 'File written.')
      assert.ok(applied)
      assert.equal(applied.status, 'done')
      assert.equal(Object.hasOwn(applied, 'deferred'), false)
      if (retryId !== 'call_0') assert.equal(calls[0]?.deferred, true)
    }
  })
}
