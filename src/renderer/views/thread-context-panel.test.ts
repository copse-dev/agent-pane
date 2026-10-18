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
    title: 'Fix the flaky test',
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
      openSideChat: (id) => calls.push(`side:${id}`),
      openPr: (ref) => calls.push(`pr:${String(ref.number)}`),
      openUrl: (url) => calls.push(`url:${url}`),
      startSideChat: () => calls.push('start'),
      archiveSideChat: (id) => calls.push(`archive:${id}`),
      restoreSideChat: (id) => calls.push(`restore:${id}`),
    },
  }
}

test('identifies primary and worktree checkouts with their branch', () => {
  for (const checkout of ['shared', 'worktree'] as const) {
    const host = renderThreadContext(
      model({ repos: [{ name: 'Widgets', path: '/work/widgets', branch: 'feature/x', checkout }] }),
      recorder().handlers,
    )
    assert.equal(
      host.querySelector('.thread-context-repo .thread-context-meta')?.textContent,
      `${checkout === 'worktree' ? 'Worktree' : 'Primary'} · feature/x`,
    )
  }
})

test('renders every section with safe text and routes each click to its own handler', () => {
  const { handlers, calls } = recorder()
  const host = renderThreadContext(model(), handlers)

  for (const kind of ['repos', 'side-chats', 'links', 'subagents'])
    assert.ok(host.querySelector(`[data-context-section="${kind}"]`), kind)
  assert.equal(host.querySelector('img'), null, 'titles are text, never markup')
  assert.equal(host.querySelectorAll('[data-side-chat-id][data-unread="true"]').length, 1)
  assert.ok(host.querySelector('.chat-unread-dot'))
  assert.equal(
    host.querySelector('.thread-context-thread-title')?.textContent,
    'Fix the flaky test',
  )
  assert.deepEqual(
    Array.from(host.querySelectorAll('[data-context-section]'), (node) =>
      node.getAttribute('data-context-section'),
    ),
    ['subagents', 'repos', 'links', 'sources', 'side-chats'],
  )
  assert.equal(host.querySelector('.thread-context-count')?.textContent, '1 done')
  assert.ok(host.querySelector('[data-context-section="sources"] [data-link-key="url:u"]'))
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
    'side:s1',
  ])
})

test('shows linked PR lifecycle and prioritizes merge conflicts over failing checks', () => {
  const statuses = new Map([
    [
      'acme/widget#42',
      { state: 'open' as const, checks: 'failure' as const, conflicts: true, fetchedAt: 1 },
    ],
  ])
  const host = renderThreadContext(model(), recorder().handlers, statuses)
  const row = host.querySelector('[data-link-key="pr:acme/widget#42"]')
  const status = row?.querySelector('.thread-context-pr-status')
  assert.ok(status)
  assert.ok(status.classList.contains('is-open'))
  assert.ok(status.classList.contains('has-conflicts'))
  assert.equal(status.classList.contains('has-ci-failure'), false)
  assert.match(status.getAttribute('aria-label') ?? '', /checks are failing; merge conflicts/)
  assert.equal(row?.querySelector('.thread-context-chip')?.textContent, 'Open')
  assert.equal(status.querySelector('svg path:nth-child(2)')?.getAttribute('d'), 'M3 3l6 6m0-6L3 9')

  const merged = renderThreadContext(
    model(),
    recorder().handlers,
    new Map([['acme/widget#42', { state: 'merged' as const, fetchedAt: 2 }]]),
  )
  assert.ok(merged.querySelector('.thread-context-pr-status.is-merged svg[data-icon="git-merge"]'))
  assert.equal(
    merged.querySelector('[data-link-key="pr:acme/widget#42"] .thread-context-chip')?.textContent,
    'Merged',
  )
})

test('the mounted Context panel resolves a linked PR from GitHub', async () => {
  const store = createStore()
  store.setState({
    activeProjectId: 'p',
    projects: [{ id: 'p', path: '/work/widgets', name: 'Widgets' }],
    filesPaneOpen: true,
    rightPanelMode: 'context',
  })
  const threadId = createThread(store)
  store.setState({
    threads: store
      .getState()
      .threads.map((thread) => (thread.id === threadId ? { ...thread, prRefs: [pr] } : thread)),
  })
  const base = createFakeApi()
  const api = {
    ...base,
    gh: {
      ...base.gh,
      prDetails: async () => ({
        ...pr,
        title: 'Fix widgets',
        state: 'OPEN',
        body: '',
        files: [],
      }),
      prChecks: async () => 'failure' as const,
    },
  }
  const viewer = document.createElement('div')
  const dispose = mountThreadContextPane(document.createElement('div'), viewer, store, api)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const status = viewer.querySelector('.thread-context-pr-status.is-open.has-ci-failure')
  assert.ok(status)
  assert.match(status.getAttribute('aria-label') ?? '', /checks are failing/)
  assert.equal(
    viewer.querySelector('[data-link-group="pr"] .thread-context-chip')?.textContent,
    'Open',
  )
  dispose()
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
  assert.equal(host.querySelectorAll('.thread-context-empty').length, 5)
})

test('the mounted pane renders the active thread, uses one header, and starts a side chat', async () => {
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
  assert.equal(list.querySelectorAll('[data-index]').length, 0)
  assert.ok(list.querySelector('[aria-label="Close context"]'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(viewer.querySelector('[data-thread-id="other"]'), 'backlinks arrive from the index')

  const opened: string[] = []
  store.on('side_chat_open_requested', (id) => opened.push(id))
  viewer.querySelector<HTMLElement>('[data-action="new-side-chat"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(forks.length, 1)
  assert.equal(opened.length, 1, 'the new side chat is announced for the Side chat panel')
  assert.equal(store.getState().activeThreadId, threadId, 'the main thread stays open')
  assert.equal(
    viewer.querySelectorAll('.thread-context-row[data-side-chat-id]').length,
    1,
    'and it is listed under Side chats',
  )
  list.querySelector<HTMLElement>('[aria-label="Close context"]')?.click()
  assert.equal(store.getState().filesPaneOpen, false)
  dispose()
})

test('storage combines saved files with the owned checkout and archive uses the guarded flow', async () => {
  const store = createStore()
  store.setState({
    activeProjectId: 'p',
    projects: [{ id: 'p', path: '/work', name: 'Work' }],
    filesPaneOpen: true,
    rightPanelMode: 'context',
  })
  const id = createThread(store)
  store.setState({
    threads: store.getState().threads.map((t) => ({
      ...t,
      worktree: {
        path: '/checkout',
        branch: 'topic',
        baseBranch: 'main',
        baseCommit: 'abc',
        createdAt: 1,
        seededFromDirtyProject: false,
      },
    })),
  })
  const base = createFakeApi()
  const api = {
    ...base,
    threads: {
      ...base.threads,
      storageSize: async (): ReturnType<typeof base.threads.storageSize> => ({
        bytes: 1024,
        truncated: false,
      }),
    },
    git: {
      ...base.git,
      changeStats: async (): ReturnType<typeof base.git.changeStats> => ({
        additions: 42,
        deletions: 7,
      }),
    },
    worktrees: {
      ...base.worktrees,
      size: async (): ReturnType<typeof base.worktrees.size> => ({
        path: '/checkout',
        bytes: 2048,
        fileCount: 1,
        truncated: true,
      }),
    },
  }
  const viewer = document.createElement('div')
  const requests: string[][] = []
  store.on('thread_archive_requested', (...args) => requests.push(args))
  const dispose = mountThreadContextPane(document.createElement('div'), viewer, store, api)
  assert.equal(viewer.querySelector('[data-context-storage-size]')?.textContent, 'Calculating…')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(viewer.querySelector('[data-context-storage-size]')?.textContent, 'At least 3.0 KB')
  assert.equal(
    viewer.querySelector('[data-context-section="storage"] [data-context-change-stats]')
      ?.textContent,
    '+42 −7',
  )
  assert.equal(
    viewer.querySelector('[data-context-change-stats] .git-change-status-added')?.textContent,
    '+42',
  )
  assert.equal(
    viewer.querySelector('[data-context-change-stats] .git-change-status-deleted')?.textContent,
    '−7',
  )
  viewer.querySelector<HTMLElement>('[data-action="archive-thread"]')?.click()
  assert.deepEqual(requests, [['p', id]])
  assert.equal(store.getState().threads[0]?.archivedAt, undefined)
  dispose()
})

test('storage ignores a previous thread response and reports lookup failure', async () => {
  const store = createStore()
  store.setState({
    activeProjectId: 'p',
    projects: [{ id: 'p', path: '/work', name: 'Work' }],
    filesPaneOpen: true,
    rightPanelMode: 'context',
  })
  const first = createThread(store)
  let finish: (value: { bytes: number; truncated: boolean }) => void = () => {}
  const pending = new Promise<{ bytes: number; truncated: boolean }>((resolve) => {
    finish = resolve
  })
  const base = createFakeApi()
  const api = {
    ...base,
    threads: {
      ...base.threads,
      storageSize: async (
        _project: string,
        id: string,
      ): ReturnType<typeof base.threads.storageSize> => {
        if (id === first) return pending
        throw new Error('Disk unavailable')
      },
    },
  }
  const viewer = document.createElement('div')
  const dispose = mountThreadContextPane(document.createElement('div'), viewer, store, api)
  createThread(store)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(viewer.querySelector('[data-context-storage-size]')?.textContent, 'Unavailable')
  finish({ bytes: 1024, truncated: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(viewer.querySelector('[data-context-storage-size]')?.textContent, 'Unavailable')
  dispose()
})

test('Storage line totals reject stale thread replies, handle clean checkouts and stop while hidden', async () => {
  const store = createStore()
  store.setState({
    activeProjectId: 'p',
    projects: [{ id: 'p', path: '/work', name: 'Work' }],
    filesPaneOpen: true,
    rightPanelMode: 'context',
  })
  createThread(store)
  const base = createFakeApi()
  const replies: Array<{
    resolve: (stats: { additions: number; deletions: number } | null) => void
    reject: (error: Error) => void
  }> = []
  const api = {
    ...base,
    git: {
      ...base.git,
      changeStats: (): ReturnType<typeof base.git.changeStats> =>
        new Promise((resolve, reject) => replies.push({ resolve, reject })),
    },
  }
  const viewer = document.createElement('div')
  const dispose = mountThreadContextPane(document.createElement('div'), viewer, store, api)
  createThread(store)
  assert.equal(replies.length, 2)
  replies[1]?.resolve(null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  replies[0]?.resolve({ additions: 100, deletions: 20 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(viewer.querySelector('[data-context-change-stats]')?.textContent, '+0 −0')
  store.emit('message_done', 'completed-message')
  replies[2]?.reject(new Error('Git unavailable'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(viewer.querySelector('[data-context-change-stats]')?.textContent, 'Unavailable')
  assert.equal(
    viewer.querySelector('[data-context-storage-size]')?.textContent,
    '24 KB',
    'Git failure does not affect disk size',
  )
  store.setState({ filesPaneOpen: false })
  store.emit('message_done', 'completed-message')
  assert.equal(replies.length, 3)
  dispose()
})
