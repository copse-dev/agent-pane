import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ApiClient } from '../../preload/api.d.ts'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { beginThreadSubmission, isThreadSubmitting } from '@shared/store/pending-submissions.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { acceptMobileChat, attachMobileChat } from './mobile-chat.ts'
import type { MobileChatCommand } from '@shared/mobile-chat.ts'

function fixture(status: Thread['status'] = 'idle'): {
  store: ReturnType<typeof createStore>
  api: ApiClient
  runs: string[]
  command: MobileChatCommand
} {
  const thread: Thread = {
    id: 't',
    title: 'Existing conversation',
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    worktreeChoice: 'automatic',
    createdAt: 1,
    updatedAt: 1,
  }
  const store = createStore({
    activeProjectId: 'p',
    activeThreadId: 't',
    workspaceRoot: '/repo',
    projects: [{ id: 'p', name: 'Project', path: '/repo' }],
    threads: [thread],
  })
  const api = createFakeApi()
  const runs: string[] = []
  api.agent.run = (_project, _thread, payload): Promise<void> => {
    runs.push(payload)
    return new Promise(() => {})
  }
  const command: MobileChatCommand = {
    id: randomUUID(),
    projectId: 'p',
    threadId: 't',
    text: 'A message from my phone',
    expiresAt: Date.now() + 60_000,
  }
  return { store, api, runs, command }
}

test('phone follow-ups queue behind the current turn without interrupting it', async () => {
  const { store, api, runs, command } = fixture('running')
  assert.deepEqual(await acceptMobileChat(store, api, command), {
    ok: true,
    threadId: 't',
    queued: true,
  })
  assert.equal(runs.length, 0)
  assert.equal(store.getState().threads[0]?.pendingMessages?.[0]?.payload.content, command.text)
  assert.equal(store.getState().threads[0]?.messages[0]?.content, command.text)
  assert.equal(isThreadSubmitting(store, 't'), false)
})

test('phone messages at idle enter the normal dispatcher as a fresh human turn', async () => {
  const { store, api, runs, command } = fixture()
  assert.deepEqual(await acceptMobileChat(store, api, command), {
    ok: true,
    threadId: 't',
    queued: false,
  })
  assert.equal(runs.length, 1)
  assert.ok(store.getState().threads[0]?.currentEpoch)
  assert.equal(store.getState().threads[0]?.status, 'running')
  assert.equal(store.getState().threads[0]?.continuationUsed, 0)
})

test('expired, wrong-project, removed-thread and concurrent sends fail without a bubble or run', async () => {
  for (const change of [{ expiresAt: 0 }, { projectId: 'missing' }, { threadId: 'missing' }]) {
    const { store, api, runs, command } = fixture()
    assert.equal((await acceptMobileChat(store, api, { ...command, ...change })).ok, false)
    assert.equal(runs.length, 0)
    assert.equal(store.getState().threads[0]?.messages.length, 0)
  }
  const { store, api, runs, command } = fixture()
  beginThreadSubmission(store, 't')
  assert.equal((await acceptMobileChat(store, api, command)).ok, false)
  assert.equal(runs.length, 0)
})

test('new phone chats prepare a checkout before dispatch and preserve failure without sending', async () => {
  const { store, api, runs, command } = fixture()
  let prepares = 0
  api.agent.prepareCheckout = (): Promise<PreparedThreadCheckout> => {
    prepares++
    return Promise.reject(new Error('Checkout unavailable'))
  }
  const result = await acceptMobileChat(store, api, { ...command, threadId: null })
  assert.deepEqual(result, { ok: false, error: 'Checkout unavailable' })
  assert.equal(prepares, 1)
  assert.equal(runs.length, 0)
  assert.equal(store.getState().threads[0]?.messages.length, 0)
  api.agent.prepareCheckout = (): Promise<PreparedThreadCheckout> =>
    Promise.resolve({
      checkoutMode: 'shared',
      choice: 'automatic',
      branch: 'main',
    })
  const started = await acceptMobileChat(store, api, { ...command, threadId: null })
  assert.equal(started.ok, true)
  assert.equal(runs.length, 1)
})

test('a phone command waits for desktop restoration before changing the thread', async () => {
  const { store, api, runs, command } = fixture()
  let receive: (value: MobileChatCommand) => void = () => {}
  let restored: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    restored = resolve
  })
  api.mobile.onChat = (handler): (() => void) => {
    receive = handler
    return (): void => {}
  }
  attachMobileChat(store, api, ready)
  receive(command)
  await Promise.resolve()
  assert.equal(runs.length, 0)
  assert.equal(store.getState().threads[0]?.messages.length, 0)
  restored()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(runs.length, 1)
})
