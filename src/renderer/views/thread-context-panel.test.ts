import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult } from '@shared/types'
import type { ThreadBacklink } from '@shared/threads/thread-links.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ThreadContextModel } from './thread-context-model.ts'
import {
  mountThreadContextPane,
  renderThreadContext,
  type ThreadContextHandlers,
} from './thread-context-panel.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

const pr = {
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
}

function model(fields: Partial<ThreadContextModel> = {}): ThreadContextModel {
  return {
    threadId: 'main',
    repos: [{ name: 'Widgets', path: '/work/widgets', branch: 'feature/x', checkout: 'shared' }],
    links: [
      { kind: 'pr', key: 'pr:acme/widget#42', label: 'acme/widget#42', target: pr.url, pr },
      { kind: 'thread', key: 'thread:t1', label: 'Release planning', target: 't1' },
      { kind: 'thread', key: 'thread:t2', label: 'Elsewhere', target: 't2', unresolved: true },
      {
        kind: 'url',
        key: 'url:u',
        label: 'docs.example.com/a',
        target: 'https://docs.example.com/a',
      },
    ],
    mentionedIn: [{ threadId: 'm1', title: '<img src=x onerror=alert(1)>' }],
    sideChats: [
      {
        id: 's1',
        title: 'Why waitFor?',
        model: 'acp:codex-acp#fast',
        anchorMessageId: 'm',
        archived: false,
        unread: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 's2',
        title: 'Old question',
        anchorMessageId: 'm',
        archived: true,
        unread: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    subagents: [{ id: 'a', kind: 'explore', status: 'done', prompt: 'Find it' }],
    ...fields,
  }
}

function recorder(): { handlers: ThreadContextHandlers; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    handlers: {
      openThread: (id) => calls.push(`thread:${id}`),
      openPr: (ref) => calls.push(`pr:${String(ref.number)}`),
      openUrl: (url) => calls.push(`url:${url}`),
      startSideChat: () => calls.push('start'),
      archiveSideChat: (id) => calls.push(`archive:${id}`),
      restoreSideChat: (id) => calls.push(`restore:${id}`),
    },
  }
}

test('renders every section with safe text and routes each click to its own handler', () => {
  const { handlers, calls } = recorder()
  const host = renderThreadContext(model(), handlers)

  for (const kind of ['repos', 'side-chats', 'links', 'subagents'])
    assert.ok(host.querySelector(`[data-context-section="${kind}"]`), kind)
  assert.equal(host.querySelector('img'), null, 'titles are text, never markup')
  assert.equal(host.querySelectorAll('[data-side-chat-id][data-unread="true"]').length, 1)
  assert.ok(host.querySelector('.chat-unread-dot'))
  assert.equal(host.querySelector('[data-link-key="thread:t2"]')?.hasAttribute('disabled'), true)

  host.querySelector<HTMLElement>('[data-link-key="pr:acme/widget#42"]')?.click()
  host.querySelector<HTMLElement>('[data-link-key="thread:t1"]')?.click()
  host.querySelector<HTMLElement>('[data-link-key="thread:t2"]')?.click() // disabled: no call
  host.querySelector<HTMLElement>('[data-link-key="url:u"]')?.click()
  host.querySelector<HTMLElement>('[data-thread-id="m1"]')?.click()
  host.querySelector<HTMLElement>('[data-action="new-side-chat"]')?.click()
  host
    .querySelector<HTMLElement>('[data-action="archive-side-chat"][data-side-chat-id="s1"]')
    ?.click()
  host
    .querySelector<HTMLElement>('[data-action="restore-side-chat"][data-side-chat-id="s2"]')
    ?.click()
  host.querySelector<HTMLElement>('.thread-context-row[data-side-chat-id="s1"]')?.click()

  assert.deepEqual(calls, [
    'pr:42',
    'thread:t1',
    'url:https://docs.example.com/a',
    'thread:m1',
    'start',
    'archive:s1',
    'restore:s2',
    'thread:s1',
  ])
})

test('a side chat links back to its parent and cannot start another', () => {
  const { handlers, calls } = recorder()
  const host = renderThreadContext(
    model({
      sideOf: { parentThreadId: 'main', parentTitle: 'Fix flaky e2e', anchorExcerpt: 'The race' },
      sideChats: [],
    }),
    handlers,
  )
  assert.match(host.querySelector('[data-context="side-of"]')?.textContent ?? '', /Read-only/)
  assert.equal(host.querySelector('[data-action="new-side-chat"]')?.hasAttribute('disabled'), true)
  host.querySelector<HTMLElement>('[data-action="back-to-parent"]')?.click()
  assert.deepEqual(calls, ['thread:main'])
})

test('empty sections say so', () => {
  const host = renderThreadContext(
    model({ repos: [], links: [], mentionedIn: [], sideChats: [], subagents: [] }),
    recorder().handlers,
  )
  assert.equal(host.querySelectorAll('.thread-context-empty').length, 4)
})

test('the mounted pane renders the active thread, indexes sections, and starts a side chat', async () => {
  const store = createStore()
  store.setState({
    activeProjectId: 'p',
    projects: [{ id: 'p', path: '/work/widgets', name: 'Widgets' }],
    filesPaneOpen: true,
    rightPanelMode: 'context',
  })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Read https://docs.example.com/a')
  addMessage(store, threadId, 'assistant', 'Done.')
  const forks: string[][] = []
  const base = createFakeApi()
  const api = {
    ...base,
    threads: {
      ...base.threads,
      backlinks: (): Promise<ThreadBacklink[]> =>
        Promise.resolve([{ threadId: 'other', title: 'Mentions this' }]),
      fork: (...args: [string, string, string, string?]): Promise<ForkedHistoryResult> => {
        forks.push(args.map(String))
        return Promise.resolve({ source: 'rebuilt', messageCount: 2 })
      },
    },
  }
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  const dispose = mountThreadContextPane(list, viewer, store, api)

  assert.ok(viewer.querySelector('[data-link-key="url:https://docs.example.com/a"]'))
  assert.equal(list.querySelectorAll('[data-index]').length, 4)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(viewer.querySelector('[data-thread-id="other"]'), 'backlinks arrive from the index')

  viewer.querySelector<HTMLElement>('[data-action="new-side-chat"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(forks.length, 1)
  assert.ok(
    viewer.querySelector('[data-context="side-of"]'),
    'the opened side chat shows its banner',
  )
  dispose()
})
