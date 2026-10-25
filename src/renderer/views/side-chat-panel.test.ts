import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult, Message, Thread } from '@shared/types'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { startSideChat } from '../controller/side-chat.ts'
import { attachThreadHydration, ensureThreadMessages } from '../controller/thread-hydration.ts'
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
  // Still running, so Archive waits for the run to settle.
  view.header.querySelector<HTMLElement>('button')?.click()
  assert.deepEqual(archived, [])
})

const RICH_REPLY = [
  'Here is the flow:',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '| Step | Result |',
  '| --- | --- |',
  '| build | ok |',
  '',
  '```sh',
  'pnpm test',
  '```',
].join('\n')

test('renders prompts and replies with the main conversation’s message markdown', () => {
  const side = thread('s', {
    sideChat: link,
    messages: [
      message('u', 'user', 'first line\nsecond line'),
      message('a', 'assistant', RICH_REPLY),
    ],
  })
  const { body } = renderSideChat({
    side,
    parent: thread('main'),
    onSuggestion: () => {},
    onArchive: () => {},
  })

  // Composer newlines become hard breaks, as in the main transcript.
  assert.ok(body.querySelector('.is-user br'))
  const reply = body.querySelector('.is-assistant .message-text')
  // The shared Mermaid pass took the fence. This DOM cannot build the isolated
  // frame, so it settles on the source fallback; the browser spec
  // (tests/e2e/side-chat-rich-markdown.e2e.ts) checks the rendered diagram.
  assert.ok(reply?.querySelector('.mermaid-diagram[data-mermaid-ui]'), 'diagram handed to Mermaid')
  assert.ok(reply?.querySelector('.table-copy'), 'table copy button')
  assert.ok(reply?.querySelector('.code-block-copy'), 'code copy button')
  // A side chat cannot run commands: a run would land in the main thread.
  assert.equal(reply?.querySelector('.code-block-run'), null)
})

test('a settled reply and its diagram stay mounted while a later reply streams', () => {
  const body = document.createElement('div')
  document.body.append(body)
  const messageNodes = new Map()
  const draw = (partial: string): void => {
    renderSideChat({
      side: thread('s', {
        sideChat: link,
        status: 'running',
        messages: [
          message('u1', 'user', 'Draw it'),
          message('a1', 'assistant', RICH_REPLY),
          message('u2', 'user', 'And again?'),
          message('a2', 'assistant', partial),
        ],
      }),
      parent: thread('main'),
      onSuggestion: () => {},
      onArchive: () => {},
      body,
      messageNodes,
    })
  }
  try {
    draw('Working')
    const settled = body.querySelector('[data-role="assistant"]')
    const diagram = settled?.querySelector('.mermaid-diagram[data-mermaid-ui]')
    const live = body.querySelectorAll('[data-role="assistant"]')[1]
    assert.ok(settled && diagram && live)

    draw('Working on the second diagram')
    assert.equal(body.querySelector('[data-role="assistant"]'), settled)
    assert.equal(settled.querySelector('.mermaid-diagram'), diagram, 'the diagram is not rebuilt')
    assert.ok(diagram.isConnected, 'the diagram was never detached')
    // The streaming reply keeps its element so the incremental renderer resumes.
    assert.equal(body.querySelectorAll('[data-role="assistant"]')[1], live)
  } finally {
    body.remove()
  }
})

test('the context line reads a markdown anchor as plain text', () => {
  const parent = thread('main', {
    messages: [
      message(
        'm1',
        'assistant',
        '[PR #3595](https://github.com/copse-dev/agent-pane/pull/3595) is loaded at commit abc',
      ),
    ],
  })
  const side = thread('s', { sideChat: link })
  const view = renderSideChat({ side, parent, onSuggestion: () => {}, onArchive: () => {} })
  assert.match(
    view.header.querySelector('[data-side-chat-context]')?.textContent ?? '',
    /Reads the main thread up to “PR #3595 is loaded at commit abc”\. Read-only\./,
  )
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

test('a running side chat cannot be archived until its run settles', () => {
  const archived: boolean[] = []
  const running = renderSideChat({
    side: thread('s', { sideChat: link, status: 'running' }),
    parent: undefined,
    onSuggestion: () => {},
    onArchive: (value) => archived.push(value),
  })
  const button = running.header.querySelector<HTMLButtonElement>(
    '[data-action="archive-side-chat"]',
  )
  assert.ok(button)
  assert.equal(button.disabled, true)
  button.click()
  assert.equal(archived.length, 0)

  const idle = renderSideChat({
    side: thread('s', { sideChat: link }),
    parent: undefined,
    onSuggestion: () => {},
    onArchive: (value) => archived.push(value),
  })
  const idleButton = idle.header.querySelector<HTMLButtonElement>(
    '[data-action="archive-side-chat"]',
  )
  assert.ok(idleButton)
  assert.equal(idleButton.disabled, false)
  idleButton.click()
  assert.deepEqual(archived, [false])
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

    const promote = viewer.querySelector<HTMLButtonElement>('[data-action="promote-side-chat"]')
    assert.ok(promote)
    assert.equal(promote.disabled, true, 'promote waits for the run to settle')
    setThreadStatus(store, sideId, 'idle')
    await settle()
    assert.equal(promote.disabled, false)
    promote.click()
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

test('a side chat whose transcript is not read yet shows loading, not the empty-chat suggestions', () => {
  const side = thread('s', { sideChat: link, messagesLoaded: false })
  const loading = renderSideChat({
    side,
    parent: thread('main'),
    onSuggestion: () => undefined,
    onArchive: () => undefined,
  })
  assert.match(loading.body.textContent, /Loading conversation/)
  assert.equal(loading.body.querySelectorAll('[data-suggestion]').length, 0)

  const failed = renderSideChat({
    side,
    parent: thread('main'),
    loadFailed: true,
    onSuggestion: () => undefined,
    onArchive: () => undefined,
  })
  assert.match(failed.body.textContent, /Couldn’t load this side chat/)
})

test('after a restart the mounted pane reads the selected side chat transcript from disk', async () => {
  const store = createStore()
  const link = { parentThreadId: 'main', anchorMessageId: 'm1' }
  store.setState({
    activeProjectId: 'project-1',
    activeThreadId: 'main',
    filesPaneOpen: true,
    rightPanelMode: 'side-chat',
    threads: [
      thread('main', { messages: [message('m1', 'user', 'Why?')] }),
      thread('s', { sideChat: link, messagesLoaded: false }),
    ],
  })
  const base = createFakeApi()
  const reads: string[] = []
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      loadMessages: (_projectId: string, threadId: string): Promise<Message[]> => {
        reads.push(threadId)
        return Promise.resolve(
          threadId === 's'
            ? [message('q', 'user', 'Is it safe?'), message('a', 'assistant', 'Yes.')]
            : [],
        )
      },
    },
  }
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const detachHydration = attachThreadHydration(store, api)
  const dispose = mountSideChatPane(list, viewer, store, api)
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
  try {
    await settle()
    assert.ok(reads.includes('s'), 'the selected side chat was read')
    assert.equal(reads.filter((id) => id === 's').length, 1, 'read once, not per render')
    assert.equal(viewer.querySelector('.is-user')?.textContent, 'Is it safe?')
    assert.equal(viewer.querySelectorAll('[data-suggestion]').length, 0)
    assert.equal(viewer.querySelector<HTMLInputElement>('.side-chat-input')?.disabled, false)
  } finally {
    dispose()
    detachHydration()
    document.body.replaceChildren()
  }
})

test('the mounted panel pins only its selected transcript and releases it when hidden', async () => {
  const store = createStore()
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      loadMessages: async (_projectId, threadId) => [
        message(`${threadId}-answer`, 'assistant', `Answer ${threadId}`),
      ],
    },
  }
  store.setState({
    activeProjectId: 'project-1',
    activeThreadId: 'main',
    filesPaneOpen: true,
    rightPanelMode: 'side-chat',
    threads: [
      thread('main'),
      ...Array.from({ length: 14 }, (_, i) =>
        thread(`side-${String(i)}`, { sideChat: link, messagesLoaded: false }),
      ),
    ],
  })
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const detach = attachThreadHydration(store, api)
  const dispose = mountSideChatPane(list, viewer, store, api)
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
  try {
    await settle()
    for (let i = 1; i < 14; i++) {
      const row = list.querySelector<HTMLButtonElement>(`[data-side-chat-id="side-${String(i)}"]`)
      assert.ok(row)
      row.click()
      await settle()
      assert.match(viewer.textContent, new RegExp(`Answer side-${String(i)}`))
      assert.ok(store.getState().threads.filter((t) => t.messagesLoaded === true).length <= 9)
    }
    assert.equal(store.getState().threads.find((t) => t.id === 'side-0')?.messagesLoaded, false)
    // Closing releases the latest pin; the next loads can evict it normally.
    store.setState({ filesPaneOpen: false })
    store.emit('files_pane_changed')
    for (let i = 0; i < 13; i++) await ensureThreadMessages('project-1', `side-${String(i)}`)
    assert.equal(store.getState().threads.find((t) => t.id === 'side-13')?.messagesLoaded, false)
  } finally {
    dispose()
    detach()
    document.body.replaceChildren()
  }
})
