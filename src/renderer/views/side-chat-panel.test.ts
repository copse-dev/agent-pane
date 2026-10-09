import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult, Message, Thread } from '@shared/types'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { startSideChat } from '../controller/side-chat.ts'
import {
  mountSideChatPane,
  renderSideChat,
  resolveSideChatSelection,
  SIDE_CHAT_SUGGESTIONS,
} from './side-chat-panel.ts'

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, toolCalls: [], createdAt: 1 }
}

function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

const link = { parentThreadId: 'main', anchorMessageId: 'm1' }

test('shows the remembered live side chat, else the first live one, else an archived one', () => {
  const threads = [
    thread('main'),
    thread('a', { sideChat: link, createdAt: 1 }),
    thread('b', { sideChat: link, createdAt: 2 }),
    thread('old', { sideChat: link, createdAt: 0, archivedAt: 5 }),
  ]
  const none = new Map<string, string>()
  assert.equal(resolveSideChatSelection(threads, 'main', none).selectedId, 'a')
  assert.equal(resolveSideChatSelection(threads, 'main', new Map([['main', 'b']])).selectedId, 'b')
  // A remembered archived chat yields to a live one; archived rows list last.
  const selection = resolveSideChatSelection(threads, 'main', new Map([['main', 'old']]))
  assert.equal(selection.selectedId, 'a')
  assert.deepEqual(
    selection.rows.map((row) => row.id),
    ['a', 'b', 'old'],
  )
  const onlyArchived = [threads[0], threads[3]].filter((t): t is Thread => t !== undefined)
  assert.equal(resolveSideChatSelection(onlyArchived, 'main', none).selectedId, 'old')
  assert.equal(resolveSideChatSelection([thread('main')], 'main', none).selectedId, null)
  assert.equal(resolveSideChatSelection(threads, null, none).mainId, null)
})

test('an open side chat resolves to itself and to its parent as the main thread', () => {
  const threads = [thread('main'), thread('a', { sideChat: link }), thread('b', { sideChat: link })]
  const selection = resolveSideChatSelection(threads, 'b', new Map([['main', 'a']]))
  assert.equal(selection.mainId, 'main')
  assert.equal(selection.selectedId, 'b')
})

test('renders the context line, safe messages, tool names, a thinking marker and suggestions', () => {
  const parent = thread('main', { messages: [message('m1', 'user', 'The spec flakes\nmore')] })
  const side = thread('s', {
    title: 'Why flaky?',
    model: 'acp:codex-acp#fast',
    status: 'running',
    sideChat: link,
    messages: [
      message('u', 'user', '<img src=x onerror=alert(1)>'),
      {
        ...message('a', 'assistant', 'Use `waitForDisplayed`.'),
        toolCalls: [{ id: 't', name: 'read_file', args: {}, status: 'done', result: '' }],
      },
      message('e', 'error', 'The model is unavailable'),
    ],
  })
  const archived: boolean[] = []
  const view = renderSideChat({
    side,
    parent,
    onSuggestion: () => {},
    onArchive: (value) => archived.push(value),
  })

  assert.match(view.header.textContent, /Why flaky\?/)
  assert.match(view.header.textContent, /acp:codex-acp#fast/)
  assert.match(
    view.header.querySelector('[data-side-chat-context]')?.textContent ?? '',
    /Reads the main thread up to “The spec flakes”\. Read-only\./,
  )
  assert.equal(view.body.querySelector('img'), null, 'user text is never markup')
  assert.equal(view.body.querySelector('.is-user')?.textContent, '<img src=x onerror=alert(1)>')
  assert.equal(view.body.querySelector('.is-assistant code')?.textContent, 'waitForDisplayed')
  assert.equal(view.body.querySelector('[data-tool="read_file"]')?.textContent, 'read_file')
  assert.equal(view.body.querySelector('.is-error')?.textContent, 'The model is unavailable')
  assert.match(view.body.querySelector('.side-chat-typing')?.textContent ?? '', /thinking/)
  assert.equal(view.body.querySelectorAll('[data-suggestion]').length, 0)
  view.header.querySelector<HTMLElement>('button')?.click()
  assert.deepEqual(archived, [false])
})

test('an empty side chat offers the prototype suggestions, and an archived one offers restore', () => {
  const asked: string[] = []
  const live = renderSideChat({
    side: thread('s', { sideChat: link }),
    parent: undefined,
    onSuggestion: (text) => asked.push(text),
    onArchive: () => {},
  })
  const buttons = [...live.body.querySelectorAll<HTMLElement>('[data-suggestion]')]
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [...SIDE_CHAT_SUGGESTIONS],
  )
  buttons[1]?.click()
  assert.deepEqual(asked, ['What alternatives did you consider?'])

  // An archived side chat takes no new questions, so it offers no suggestions.
  const view = renderSideChat({
    side: thread('s', { sideChat: link, archivedAt: 3 }),
    parent: undefined,
    onSuggestion: (text) => asked.push(text),
    onArchive: () => {},
  })
  assert.equal(view.body.querySelectorAll('[data-suggestion]').length, 0)
  assert.match(view.body.textContent, /archived/)
  assert.equal(
    view.header.querySelector('[data-action="restore-side-chat"]')?.textContent,
    'Restore',
  )
  assert.match(
    view.header.querySelector('[data-side-chat-context]')?.textContent ?? '',
    /up to where it branched/,
  )
})

test('the mounted pane shows a requested side chat beside the main thread, sends and promotes', async () => {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1', filesPaneOpen: true, rightPanelMode: 'side-chat' })
  const mainId = createThread(store)
  addMessage(store, mainId, 'user', 'Why is it flaky?')
  addMessage(store, mainId, 'assistant', 'A race.')
  const base = createFakeApi()
  const runs: string[] = []
  const forks: string[][] = []
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      fork: (...args: [string, string, string, string?]): Promise<ForkedHistoryResult> => {
        forks.push(args.map(String))
        return Promise.resolve({ source: 'rebuilt', messageCount: 2 })
      },
    },
    agent: {
      ...base.agent,
      run: (_projectId: string, threadId: string): Promise<void> => {
        runs.push(threadId)
        return Promise.resolve()
      },
    },
  }
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const dispose = mountSideChatPane(list, viewer, store, api)
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
  try {
    await settle()
    assert.match(viewer.textContent, /Branch a question off any message/)

    const sideId = await startSideChat(store, api, mainId)
    assert.ok(sideId)
    await settle()
    assert.equal(store.getState().activeThreadId, mainId, 'the main thread stays open')
    assert.equal(list.querySelectorAll('[data-side-chat-id]').length, 1)
    assert.equal(viewer.querySelectorAll('[data-suggestion]').length, 3)

    const input = viewer.querySelector<HTMLInputElement>('.side-chat-input')
    assert.ok(input)
    input.value = '  Is it safe?  '
    viewer.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    assert.deepEqual(runs, [sideId])
    assert.equal(input.value, '', 'the composer clears after sending')
    assert.equal(viewer.querySelector('.is-user')?.textContent, 'Is it safe?')

    viewer.querySelector<HTMLElement>('[data-action="promote-side-chat"]')?.click()
    await settle()
    const promoted = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
    assert.ok(promoted && promoted.id !== mainId && promoted.sideChat === undefined)
    assert.deepEqual(
      promoted.messages.map((m) => m.content),
      ['Why is it flaky?', 'A race.', 'Is it safe?'],
    )
  } finally {
    dispose()
    document.body.replaceChildren()
  }
})
