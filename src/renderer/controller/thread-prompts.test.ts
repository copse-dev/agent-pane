import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types/thread.ts'
import type { ThreadPromptCommand } from '@shared/thread-prompt.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { acceptThreadPrompt } from './thread-prompts.ts'
import { startHumanTurnTree } from './message-queue.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import {
  DEFAULT_CONTINUATION_BUDGET,
  DEFAULT_CROSS_THREAD_PROMPT_BUDGET,
} from '@copse/agent/hooks/continuation-budget.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'

function fixture(
  status: Thread['status'] = 'idle',
  background = false,
): {
  store: AppStore
  api: ApiClient
  runs: string[]
  command: ThreadPromptCommand
} {
  const thread: Thread = {
    id: 'destination',
    title: 'Destination',
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    worktreeChoice: 'automatic',
  }
  const store = createStore({
    activeProjectId: 'visible-project',
    activeThreadId: 'visible-thread',
    threads: background ? [] : [thread],
  })
  const api = createFakeApi()
  const runs: string[] = []
  api.agent.run = (projectId, threadId): Promise<void> => {
    runs.push(`${projectId}/${threadId}`)
    return new Promise(() => {})
  }
  const command: ThreadPromptCommand = {
    id: 'command',
    sourceThreadId: 'source',
    sourceTurnTreeId: 'source-user-turn-1',
    projectId: background ? 'other-project' : 'visible-project',
    thread,
    text: 'Check the build',
    expiresAt: Date.now() + 60_000,
  }
  return { store, api, runs, command }
}

test('cross-thread prompts run at idle without changing focus or starting a human turn tree', async () => {
  const { store, api, runs, command } = fixture()
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.deepEqual(runs, ['visible-project/destination'])
  assert.equal(store.getState().activeThreadId, 'visible-thread')
  const destination = getThreadById(store, 'destination')
  assert.equal(destination?.messages[0]?.origin?.kind, 'machine')
  assert.equal(destination.continuationUsed, undefined)
  assert.equal(
    destination.crossThreadPromptCounts?.[JSON.stringify(['source', command.sourceTurnTreeId])],
    1,
  )
  assert.equal(destination.currentEpoch, command.sourceTurnTreeId)
})

test('busy or paused destination threads queue without interruption', async () => {
  for (const status of ['running', 'idle'] as const) {
    const { store, api, runs, command } = fixture(status)
    if (status === 'idle') store.setState({ threads: [{ ...command.thread, queuePaused: true }] })
    assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: true })
    assert.deepEqual(runs, [])
    assert.equal(getThreadById(store, 'destination')?.pendingMessages?.[0]?.origin?.kind, 'machine')
  }
})

test('a conversation in another project uses its own project without switching the UI', async () => {
  const { store, api, runs, command } = fixture('idle', true)
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.deepEqual(runs, ['other-project/destination'])
  assert.equal(store.getState().activeProjectId, 'visible-project')
})

test('exhausted self-continuation budget still allows a cross-thread prompt', async () => {
  const { store, api, runs, command } = fixture()
  store.setState({
    threads: [
      {
        ...command.thread,
        currentEpoch: 'existing',
        continuationUsed: DEFAULT_CONTINUATION_BUDGET,
      },
    ],
  })
  const persisted: Partial<Thread>[] = []
  api.threads.updateMeta = async (_projectId, _threadId, patch): Promise<void> => {
    persisted.push(patch)
  }
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.equal(runs.length, 1)
  const destination = getThreadById(store, 'destination')
  assert.equal(destination?.continuationUsed, DEFAULT_CONTINUATION_BUDGET)
  assert.equal(
    destination.crossThreadPromptCounts?.[JSON.stringify(['source', command.sourceTurnTreeId])],
    1,
  )
  assert.equal(destination.currentEpoch, 'existing')
  assert.equal(
    persisted[0]?.crossThreadPromptCounts?.[JSON.stringify(['source', command.sourceTurnTreeId])],
    1,
  )
})

test('exhausted cross-thread allowance holds prompts even with self-continuation budget left', async () => {
  const { store, api, runs, command } = fixture()
  store.setState({
    threads: [
      {
        ...command.thread,
        crossThreadPromptCounts: {
          [JSON.stringify(['source', command.sourceTurnTreeId])]:
            DEFAULT_CROSS_THREAD_PROMPT_BUDGET,
        },
      },
    ],
  })
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: true })
  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'destination')?.pendingMessages?.[0]?.autoDispatch, false)
})

test('each destination gets five prompts per sender user turn, including after reload', async () => {
  const { store, api, runs, command } = fixture()
  const second = { ...command.thread, id: 'second-destination' }
  store.setState({ threads: [command.thread, second] })
  api.agent.run = async (_projectId, threadId): Promise<void> => {
    runs.push(threadId)
  }
  for (const destination of [command.thread, second]) {
    for (let i = 0; i < 6; i++) {
      const result = await acceptThreadPrompt(store, api, { ...command, thread: destination })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(result, { ok: true, queued: i === 5 })
      store.setState({ threads: store.getState().threads.map((t) => ({ ...t, status: 'idle' })) })
    }
  }
  assert.equal(runs.length, 10)
  // A human turn in the destination cannot replenish the sender's old allowance.
  startHumanTurnTree(store, command.thread.id)
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: true })
  // A renderer reload preserves metadata and both old held prompts.
  const reloaded = createStore({ ...store.getState() })
  for (const destination of [command.thread, second]) {
    assert.deepEqual(
      await acceptThreadPrompt(reloaded, api, {
        ...command,
        thread: destination,
        sourceTurnTreeId: 'source-user-turn-2',
      }),
      { ok: true, queued: false },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      getThreadById(reloaded, destination.id)?.pendingMessages?.length,
      destination.id === command.thread.id ? 2 : 1,
    )
  }
  assert.equal(runs.length, 12)
  reloaded.setState({ threads: reloaded.getState().threads.map((t) => ({ ...t, status: 'idle' })) })
  assert.deepEqual(await acceptThreadPrompt(reloaded, api, command), { ok: true, queued: true })
  assert.equal(runs.length, 12)
  // Another sender has its own allowance, even if it has the same epoch string.
  reloaded.setState({ threads: reloaded.getState().threads.map((t) => ({ ...t, status: 'idle' })) })
  assert.deepEqual(
    await acceptThreadPrompt(reloaded, api, {
      ...command,
      sourceThreadId: 'another-source',
    }),
    { ok: true, queued: false },
  )
  assert.equal(runs.length, 13)
})

test('expired and self-targeted prompts never append a message', async () => {
  const { store, api, command } = fixture()
  assert.equal((await acceptThreadPrompt(store, api, { ...command, expiresAt: 0 })).ok, false)
  assert.equal(
    (await acceptThreadPrompt(store, api, { ...command, sourceThreadId: 'destination' })).ok,
    false,
  )
  assert.equal(getThreadById(store, 'destination')?.messages.length, 0)
})

test('a destination with a previous error can run a new prompt', async () => {
  const { store, api, runs, command } = fixture('error')
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.deepEqual(runs, ['visible-project/destination'])
})

test('an unopened background destination hydrates without losing local messages', async () => {
  const { store, api, runs, command } = fixture('idle', true)
  const diskMessage = {
    id: 'disk',
    role: 'assistant' as const,
    content: 'Previous work',
    toolCalls: [],
    createdAt: 1,
  }
  const localMessage = {
    id: 'local',
    role: 'assistant' as const,
    content: 'Live tail',
    toolCalls: [],
    createdAt: 2,
  }
  command.thread = { ...command.thread, messages: [diskMessage], messagesLoaded: true }
  store.setState({
    backgroundThreads: [
      {
        projectId: command.projectId,
        thread: { ...command.thread, messages: [localMessage], messagesLoaded: false },
      },
    ],
  })
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.deepEqual(runs, ['other-project/destination'])
  assert.deepEqual(
    getThreadById(store, 'destination')
      ?.messages.slice(0, 2)
      .map((message) => message.id),
    ['disk', 'local'],
  )
})

test('a blank destination prepares its checkout before running', async () => {
  const { store, api, runs, command } = fixture()
  const { worktreeChoice: _choice, ...blank } = command.thread
  store.setState({ threads: [blank] })
  const prepared: string[] = []
  api.agent.prepareCheckout = async (
    projectId,
    threadId,
    prompt,
    choice,
  ): Promise<PreparedThreadCheckout> => {
    prepared.push(`${projectId}/${threadId}/${prompt}/${choice}`)
    return { choice: 'automatic', checkoutMode: 'shared', branch: null }
  }
  assert.deepEqual(await acceptThreadPrompt(store, api, command), { ok: true, queued: false })
  assert.deepEqual(prepared, ['visible-project/destination/Check the build/automatic'])
  assert.deepEqual(runs, ['visible-project/destination'])
  assert.equal(getThreadById(store, 'destination')?.worktreeChoice, 'automatic')
})

for (const status of ['idle', 'running'] as const) {
  test(`metadata failure preserves acceptance of a prompt to an ${status} destination`, async (t) => {
    const { store, api, runs, command } = fixture(status)
    const failure = new Error('disk unavailable')
    const errors = t.mock.method(console, 'error', () => {})
    api.threads.updateMeta = async (): Promise<void> => {
      throw failure
    }
    assert.deepEqual(await acceptThreadPrompt(store, api, command), {
      ok: true,
      queued: status === 'running',
    })
    const destination = getThreadById(store, 'destination')
    assert.ok(destination)
    assert.equal(destination.messages.length, 1)
    assert.equal(destination.pendingMessages?.length ?? 0, status === 'running' ? 1 : 0)
    assert.deepEqual(runs, status === 'idle' ? ['visible-project/destination'] : [])
    assert.equal(errors.mock.callCount(), 1)
    const logged = errors.mock.calls[0]
    assert.ok(logged)
    assert.equal(logged.arguments[1], failure)
  })
}

test('checkout persistence failures before acceptance still reject without adding a prompt', async () => {
  const { store, api, runs, command } = fixture()
  const { worktreeChoice: _choice, ...blank } = command.thread
  store.setState({ threads: [blank] })
  api.agent.prepareCheckout = async (): Promise<PreparedThreadCheckout> => {
    throw new Error('checkout unavailable')
  }
  assert.deepEqual(await acceptThreadPrompt(store, api, command), {
    ok: false,
    error: 'checkout unavailable',
  })
  assert.equal(getThreadById(store, 'destination')?.messages.length, 0)
  assert.deepEqual(runs, [])
})
