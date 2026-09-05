import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, setThreadTitle } from '@shared/store/thread-helpers.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { maybeNameThread } from './thread-naming.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function requireThread(store: AppStore, id: string): Thread {
  const found = getThreadById(store, id)
  if (!found) throw new Error(`expected thread '${id}' to exist`)
  return found
}

function newThread(id: string, messages: Message[] = []): Thread {
  return {
    id,
    title: 'New Thread',
    status: 'running',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

let messageSeq = 0
function userMessage(content: string): Message {
  messageSeq += 1
  return {
    id: `u${String(messageSeq)}`,
    role: 'user',
    content,
    toolCalls: [],
    createdAt: 1,
  }
}

function addUserMessages(store: AppStore, threadId: string, contents: string[]): void {
  const { threads } = store.getState()
  store.setState({
    threads: threads.map((t) =>
      t.id === threadId ? { ...t, messages: [...t.messages, ...contents.map(userMessage)] } : t,
    ),
  })
}

function apiWithTitle(suggest: (text: string) => Promise<string | null>): {
  api: ApiClient
  titleCalls: string[]
} {
  const titleCalls: string[] = []
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        suggestTitle: async (text: string): Promise<string | null> => {
          titleCalls.push(text)
          return suggest(text)
        },
      },
    } satisfies ApiClient
  })()
  return { api, titleCalls }
}

test('maybeNameThread suggests a title from the first user message', async () => {
  const store = createStore({
    threads: [newThread('t-name', [userMessage('Add a login button')])],
    activeThreadId: 't-name',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Generated Title')

  maybeNameThread(store, api, 't-name')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Add a login button'])
  assert.equal(requireThread(store, 't-name').title, 'Generated Title')
})

test('maybeNameThread falls back to first words when suggestTitle fails', async () => {
  const store = createStore({
    threads: [newThread('t-fallback', [userMessage('Fix the flicker please now')])],
    activeThreadId: 't-fallback',
  })
  const { api } = apiWithTitle(async () => {
    throw new Error('no small-tasks model')
  })

  maybeNameThread(store, api, 't-fallback')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't-fallback').title, 'Fix the flicker please now')
})

test('maybeNameThread is a no-op when the title is already set', async () => {
  const named = newThread('t-named', [userMessage('Already named')])
  named.title = 'Custom Title'
  const store = createStore({ threads: [named], activeThreadId: 't-named' })
  const { api, titleCalls } = apiWithTitle(async () => 'Should Not Apply')

  maybeNameThread(store, api, 't-named')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, [])
  assert.equal(requireThread(store, 't-named').title, 'Custom Title')
})

test('maybeNameThread does not overwrite a rename that lands while suggestTitle is in flight', async () => {
  const store = createStore({
    threads: [newThread('t-race', [userMessage('Race me')])],
    activeThreadId: 't-race',
  })
  let resolveTitle!: (value: string) => void
  const { api, titleCalls } = apiWithTitle(
    () =>
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      }),
  )

  maybeNameThread(store, api, 't-race')
  setThreadTitle(store, 't-race', 'User Renamed')
  resolveTitle('Late Suggestion')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Race me'])
  assert.equal(requireThread(store, 't-race').title, 'User Renamed')
})

test('maybeNameThread does not re-name a thread that has not grown', async () => {
  const store = createStore({
    threads: [newThread('t-once', [userMessage('Name me once')])],
    activeThreadId: 't-once',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Once')

  maybeNameThread(store, api, 't-once')
  await new Promise((r) => setTimeout(r, 0))
  maybeNameThread(store, api, 't-once')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Name me once'])
  assert.equal(requireThread(store, 't-once').title, 'Once')
})

test('maybeNameThread re-names its own title once the thread has grown', async () => {
  const store = createStore({
    threads: [newThread('t-grow', [userMessage('Add a login button')])],
    activeThreadId: 't-grow',
  })
  const { api, titleCalls } = apiWithTitle(async (text) =>
    text.includes('the whole auth flow') ? 'Rework The Auth Flow' : 'Add Login Button',
  )

  maybeNameThread(store, api, 't-grow')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(requireThread(store, 't-grow').title, 'Add Login Button')

  addUserMessages(store, 't-grow', ['Now the signup form', 'Actually rework the whole auth flow'])
  maybeNameThread(store, api, 't-grow')
  await new Promise((r) => setTimeout(r, 0))

  // The second pass sees the opening message plus what came after it.
  assert.equal(
    titleCalls[1],
    'Add a login button\n\nNow the signup form\n\nActually rework the whole auth flow',
  )
  assert.equal(requireThread(store, 't-grow').title, 'Rework The Auth Flow')
})

test('maybeNameThread never touches a thread the user renamed', async () => {
  const store = createStore({
    threads: [newThread('t-manual', [userMessage('Add a login button')])],
    activeThreadId: 't-manual',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Auto Title')

  maybeNameThread(store, api, 't-manual')
  await new Promise((r) => setTimeout(r, 0))
  setThreadTitle(store, 't-manual', 'Mine')

  addUserMessages(store, 't-manual', ['Second', 'Third', 'Fourth', 'Fifth'])
  maybeNameThread(store, api, 't-manual')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(titleCalls.length, 1)
  assert.equal(requireThread(store, 't-manual').title, 'Mine')
})

test('maybeNameThread stops after its last pass', async () => {
  const store = createStore({
    threads: [newThread('t-cap', [userMessage('Start')])],
    activeThreadId: 't-cap',
  })
  let suggestion = 0
  const { api, titleCalls } = apiWithTitle(async () => {
    suggestion += 1
    return `Title ${String(suggestion)}`
  })

  for (let i = 0; i < 20; i += 1) {
    maybeNameThread(store, api, 't-cap')
    await new Promise((r) => setTimeout(r, 0))
    addUserMessages(store, 't-cap', [`Message ${String(i)}`])
  }

  assert.equal(titleCalls.length, 3)
  assert.equal(requireThread(store, 't-cap').title, 'Title 3')
})

test('a failed re-name keeps the title it already had', async () => {
  const store = createStore({
    threads: [newThread('t-keep', [userMessage('Add a login button')])],
    activeThreadId: 't-keep',
  })
  const { api } = apiWithTitle(async (text) => {
    if (text.includes('Second')) throw new Error('no small-tasks model')
    return 'Add Login Button'
  })

  maybeNameThread(store, api, 't-keep')
  await new Promise((r) => setTimeout(r, 0))
  addUserMessages(store, 't-keep', ['Second', 'Third'])
  maybeNameThread(store, api, 't-keep')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't-keep').title, 'Add Login Button')
  assert.equal(requireThread(store, 't-keep').autoTitleCount, 2)
})

function hookMessage(content: string): Message {
  return { ...userMessage(content), origin: { kind: 'hook', hookId: 'stop-nudge', event: 'stop' } }
}

function addMessages(store: AppStore, threadId: string, messages: Message[]): void {
  const { threads } = store.getState()
  store.setState({
    threads: threads.map((t) =>
      t.id === threadId ? { ...t, messages: [...t.messages, ...messages] } : t,
    ),
  })
}

function setPendingMessages(store: AppStore, threadId: string, messages: Message[]): void {
  const { threads } = store.getState()
  store.setState({
    threads: threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            pendingMessages: messages.map((m) => ({
              messageId: m.id,
              payload: { content: m.content },
              createdAt: 1,
            })),
          }
        : t,
    ),
  })
}

test('the text-chunk and tool-call call sites of one turn fire a single pass', async () => {
  const store = createStore({
    threads: [newThread('t-pair', [userMessage('Add a login button')])],
    activeThreadId: 't-pair',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Add Login Button')

  // agent.ts calls on the first visible text and again on the first tool call;
  // both can land before the suggestion resolves.
  maybeNameThread(store, api, 't-pair')
  maybeNameThread(store, api, 't-pair')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Add a login button'])
  assert.equal(requireThread(store, 't-pair').autoTitleCount, 1)
})

test('a thread that jumps past a threshold still runs the pass it skipped over', async () => {
  const store = createStore({
    threads: [newThread('t-jump', [userMessage('Start')])],
    activeThreadId: 't-jump',
  })
  let suggestion = 0
  const { api, titleCalls } = apiWithTitle(async () => {
    suggestion += 1
    return `Title ${String(suggestion)}`
  })

  maybeNameThread(store, api, 't-jump')
  await new Promise((r) => setTimeout(r, 0))
  // Five user messages: past the second threshold (3) but short of the third (8).
  addUserMessages(store, 't-jump', ['Two', 'Three', 'Four', 'Five'])
  maybeNameThread(store, api, 't-jump')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(titleCalls.length, 2)
  assert.equal(requireThread(store, 't-jump').autoTitleCount, 2)
  assert.equal(requireThread(store, 't-jump').title, 'Title 2')

  // The third pass waits for the thread to actually reach its own threshold.
  maybeNameThread(store, api, 't-jump')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(titleCalls.length, 2)
})

test('hook-originated user messages neither advance a pass nor feed the model', async () => {
  const store = createStore({
    threads: [newThread('t-hook', [userMessage('Add a login button')])],
    activeThreadId: 't-hook',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Add Login Button')

  maybeNameThread(store, api, 't-hook')
  await new Promise((r) => setTimeout(r, 0))
  // Two stop-hook nudges would make three `user` messages, but say nothing about
  // the thread's goal.
  addMessages(store, 't-hook', [hookMessage('continue'), hookMessage('continue')])
  maybeNameThread(store, api, 't-hook')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(titleCalls.length, 1)

  addUserMessages(store, 't-hook', ['Now the signup form', 'And password reset'])
  maybeNameThread(store, api, 't-hook')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(titleCalls.length, 2)
  assert.equal(titleCalls[1], 'Add a login button\n\nNow the signup form\n\nAnd password reset')
})

test('queued follow-ups only count once they leave the pending queue', async () => {
  const store = createStore({
    threads: [newThread('t-queued', [userMessage('Add a login button')])],
    activeThreadId: 't-queued',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Add Login Button')

  maybeNameThread(store, api, 't-queued')
  await new Promise((r) => setTimeout(r, 0))
  // Queued follow-ups render as user bubbles before they dispatch.
  const queued = [userMessage('Then the signup form'), userMessage('Then password reset')]
  addMessages(store, 't-queued', queued)
  setPendingMessages(store, 't-queued', queued)
  maybeNameThread(store, api, 't-queued')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(titleCalls.length, 1)

  // Dispatched: the same messages now count towards the next pass.
  setPendingMessages(store, 't-queued', [])
  maybeNameThread(store, api, 't-queued')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(titleCalls.length, 2)
  assert.equal(titleCalls[1], 'Add a login button\n\nThen the signup form\n\nThen password reset')
})
