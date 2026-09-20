import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitBranchInfo, GitBranchStatus } from '@shared/types/git.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function thread(branch?: string, withMessages = false): Thread {
  const value: Thread = {
    id: 'thread-1',
    title: 'Test thread',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  if (branch) value.gitBranch = branch
  if (withMessages) {
    value.messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        toolCalls: [],
        createdAt: 1,
      },
    ]
  }
  return value
}

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  })
}

function createApi(
  status: GitBranchStatus,
  branches: GitBranchInfo[] = [],
  defaultBranch: string | null = 'main',
): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      fs: {
        ...base['fs'],
        onChanged: () => () => {},
      },
      git: {
        ...base['git'],
        branchStatus: async () => status,
        listBranches: async () => branches,
        getDefaultBranch: async () => defaultBranch,
        checkoutBranch: async (): Promise<void> => {},
      },
    } satisfies ApiClient
  })()
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function openBranchMenu(host: HTMLElement): Promise<void> {
  qsRequired<HTMLButtonElement>(host, '.branch-picker-trigger').click()
  await settle()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('footer branch status', () => {
  it('keeps a thread selectable when branch status cannot be read', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread('feature/detached-worktree', true)],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const base = createApi({ currentBranch: null, pr: null })

    mountFooterBranchStatus(host, store, {
      ...base,
      git: {
        ...base['git'],
        branchStatus: async () => {
          throw new Error('Thread worktree is on a detached HEAD')
        },
      },
    })
    await settle()

    const button = qsRequired<HTMLButtonElement>(host, '.footer-branch-status')
    assert.equal(
      button.querySelector('.footer-branch-label')?.textContent,
      'feature/detached-worktree',
    )
    assert.ok(button.classList.contains('is-copyable'))
    assert.equal(document.querySelector('.toast-error'), null)
  })

  it('keeps a readable branch status when only the branch listing fails', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const base = createApi({ currentBranch: 'main', pr: null })

    mountFooterBranchStatus(host, store, {
      ...base,
      git: {
        ...base['git'],
        listBranches: async () => {
          throw new Error('Thread worktree is missing')
        },
      },
    })
    await settle()

    // The picker's list is unavailable, but branchStatus answered — so the
    // widget still names the branch rather than hiding itself entirely.
    const wrap = qsRequired(host, '.branch-picker')
    assert.equal(wrap.hidden, false)
    assert.equal(host.querySelector('.footer-branch-label')?.textContent, 'main')
    assert.equal(document.querySelector('.toast-error'), null)
  })

  it('drops a slow branch list from a refresh the user has already overtaken', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const base = createApi({ currentBranch: 'main', pr: null })

    let releaseStale = (_value: GitBranchInfo[]): void => {
      throw new Error('expected stale refresh to pause')
    }
    let listBranches = async (): Promise<GitBranchInfo[]> => [
      { name: 'main', lastCommitDate: '2024-01-01' },
    ]

    mountFooterBranchStatus(host, store, {
      ...base,
      git: { ...base['git'], listBranches: () => listBranches() },
    })
    await settle()
    await openBranchMenu(host)

    // Refresh A stalls inside loadBranches...
    listBranches = (): Promise<GitBranchInfo[]> =>
      new Promise<GitBranchInfo[]>((resolve) => {
        releaseStale = resolve
      })
    store.emit('git_branch_changed')
    await settle()

    // ...while refresh B starts and finishes with the list that is now current.
    listBranches = async (): Promise<GitBranchInfo[]> => [
      { name: 'feature/current', lastCommitDate: '2024-01-02' },
    ]
    store.emit('git_branch_changed')
    await settle()

    releaseStale([{ name: 'feature/stale', lastCommitDate: '2024-01-03' }])
    await settle()

    const labels = [...host.querySelectorAll('.branch-picker-option-label')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(labels, ['feature/current'])
  })

  it('copies the thread branch on click for existing chats', async () => {
    let copiedBranch: string | null = null
    installClipboard(async (text) => {
      copiedBranch = text
    })

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread('feature/footer-copy', true)],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi({ currentBranch: 'main', pr: null }, [
        { name: 'main', lastCommitDate: '2024-01-01' },
        { name: 'feature/footer-copy', lastCommitDate: '2024-01-02' },
      ]),
    )
    await settle()

    const button = qsRequired<HTMLButtonElement>(host, '.footer-branch-status')
    assert.equal(button.querySelector('.footer-branch-label')?.textContent, 'feature/footer-copy')
    assert.ok(button.classList.contains('is-copyable'))
    assert.ok(qsRequired(host, '.branch-picker-chevron').hidden)

    button.click()
    await settle()

    assert.equal(copiedBranch, 'feature/footer-copy')
    assert.equal(document.querySelector('.toast')?.textContent, 'Copied branch name')
    assert.equal(host.querySelector('.branch-picker-menu')?.hasAttribute('hidden'), true)
  })

  it('opens the pull request on click for existing chats when a PR link is present', async () => {
    let copiedBranch: string | null = null
    let requestedUrl: string | null = null
    installClipboard(async (text) => {
      copiedBranch = text
    })

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread('feature/with-pr', true)],
    })
    store.on('browser_url_requested', (url) => {
      requestedUrl = url
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        {
          currentBranch: 'feature/with-pr',
          pr: {
            number: 12,
            title: 'Add branch footer copy',
            url: 'https://github.com/example/repo/pull/12',
          },
        },
        [{ name: 'feature/with-pr', lastCommitDate: '2024-01-01' }],
      ),
    )
    await settle()

    const button = qsRequired<HTMLButtonElement>(host, '.footer-branch-status')
    assert.equal(button.querySelector('.footer-branch-label')?.textContent, 'PR #12')
    assert.ok(button.classList.contains('is-link'))
    assert.ok(!button.classList.contains('is-copyable'))

    button.click()
    await settle()

    assert.equal(requestedUrl, 'https://github.com/example/repo/pull/12')
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(copiedBranch, null)
  })

  it('shows the branch name on the default branch even when an open PR exists', async () => {
    let copiedBranch: string | null = null
    let requestedUrl: string | null = null
    installClipboard(async (text) => {
      copiedBranch = text
    })

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread('main', true)],
    })
    store.on('browser_url_requested', (url) => {
      requestedUrl = url
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        {
          currentBranch: 'main',
          pr: {
            number: 1531,
            title: 'Promote main to release',
            url: 'https://github.com/example/repo/pull/1531',
          },
        },
        [],
        'main',
      ),
    )
    await settle()

    const button = qsRequired<HTMLButtonElement>(host, '.footer-branch-status')
    assert.equal(button.querySelector('.footer-branch-label')?.textContent, 'main')
    assert.ok(!button.classList.contains('is-link'))
    assert.ok(button.classList.contains('is-copyable'))

    button.click()
    await settle()

    assert.equal(requestedUrl, null)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(copiedBranch, 'main')
  })

  it('shows the branch picker for new chats without a copy action', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()

    const picker = qsRequired(host, '.branch-picker')
    assert.ok(picker.classList.contains('is-picker-mode'))
    assert.ok(!qsRequired(host, '.branch-picker-chevron').hidden)

    await openBranchMenu(host)

    assert.equal(host.querySelectorAll('.branch-picker-action').length, 0)
    const labels = [...host.querySelectorAll('.branch-picker-option-label')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(labels[0], 'main')
  })

  it('names the picked branch for the send to act on, checking out nothing', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const checkouts: string[] = []
    const base = createApi(
      { currentBranch: 'main', pr: null },
      [
        { name: 'main', lastCommitDate: '2024-01-01' },
        { name: 'feature/new', lastCommitDate: '2024-01-02' },
      ],
      'main',
    )
    const control = mountFooterBranchStatus(host, store, {
      ...base,
      git: {
        ...base['git'],
        checkoutBranch: async (_projectId: string, _threadId: string, branch: string) => {
          checkouts.push(branch)
        },
      },
    })
    await settle()
    await openBranchMenu(host)

    const option = [...host.querySelectorAll<HTMLButtonElement>('.branch-picker-option')].find(
      (node) => node.textContent.startsWith('feature/new'),
    )
    assert.ok(option)
    option.click()
    await settle()

    // Selecting states where the thread will start. Moving the user's checkout
    // for a message they have not sent is what stranded branches in other
    // worktrees, so nothing is checked out until `prepareCheckout` runs.
    assert.deepEqual(checkouts, [])
    assert.equal(host.querySelector('.footer-branch-label')?.textContent, 'feature/new')
    assert.equal(control.pendingBaseBranch('thread-1'), 'feature/new')
    assert.equal(control.pendingBaseBranch('thread-2'), undefined)
    assert.match(
      qsRequired(host, '.branch-picker-trigger').title,
      /Start this thread from: feature\/new/,
    )
  })

  it('drops a pending base branch once the thread it belonged to has started', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const control = mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)
    const option = [...host.querySelectorAll<HTMLButtonElement>('.branch-picker-option')].find(
      (node) => node.textContent.startsWith('feature/new'),
    )
    assert.ok(option)
    option.click()
    await settle()
    assert.equal(control.pendingBaseBranch('thread-1'), 'feature/new')

    store.setState({ threads: [thread(undefined, true)] })
    store.emit('threads_changed')
    await settle()

    // The selection was consumed by the first send; the thread now speaks for a
    // real checkout, and a stale preference must not outlive it.
    assert.equal(control.pendingBaseBranch('thread-1'), undefined)
  })

  it('keeps the trunk PR out of the branch picker menu too', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        {
          currentBranch: 'main',
          pr: {
            number: 1531,
            title: 'Promote main to release',
            url: 'https://github.com/example/repo/pull/1531',
          },
        },
        [{ name: 'main', lastCommitDate: '2024-01-01' }],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    // The trigger already hides the promotion PR; the menu's "Open PR #N" row
    // must agree rather than offering the branch back as a link.
    assert.equal(host.querySelectorAll('.branch-picker-action').length, 0)
    assert.equal(host.querySelector('.branch-picker-empty'), null)
    const labels = [...host.querySelectorAll('.branch-picker-option-label')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(labels, ['main'])
  })

  it('focuses the filter on open and narrows branches by a case-insensitive substring', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
          { name: 'feature/old', lastCommitDate: '2024-01-03' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    assert.equal(document.activeElement, filter)

    filter.value = 'NEW'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    const labels = [...host.querySelectorAll('.branch-picker-option-label')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(labels, ['feature/new'])
  })

  it('shows a no-match state when the filter excludes every branch', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    filter.value = 'nonexistent'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    assert.equal(host.querySelectorAll('.branch-picker-option').length, 0)
    assert.equal(
      host.querySelector('.branch-picker-empty')?.textContent,
      'No branches match "nonexistent".',
    )
  })

  it('moves the highlighted branch with ArrowDown/ArrowUp and selects it on Enter', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    const control = mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    const options = (): HTMLButtonElement[] => [
      ...host.querySelectorAll<HTMLButtonElement>('.branch-picker-option'),
    ]

    // Highlight starts on the first row (the default branch).
    assert.equal(options()[0]?.classList.contains('is-active'), true)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    assert.equal(options()[1]?.classList.contains('is-active'), true)
    assert.equal(options()[0]?.classList.contains('is-active'), false)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    assert.equal(options()[0]?.classList.contains('is-active'), true)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    filter.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    assert.equal(host.querySelector('.branch-picker-menu')?.hasAttribute('hidden'), true)
    assert.equal(control.pendingBaseBranch('thread-1'), 'feature/new')
    assert.equal(host.querySelector('.footer-branch-label')?.textContent, 'feature/new')
    assert.ok(
      document.activeElement === host.querySelector('.branch-picker-trigger'),
      'selection returns focus to the visible trigger',
    )
  })

  it('exposes the keyboard highlight as the combobox active descendant', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/new', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)
    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    const list = qsRequired(host, '.branch-picker-list')
    assert.equal(filter.getAttribute('role'), 'combobox')
    assert.equal(filter.getAttribute('aria-controls'), list.id)
    assert.equal(filter.getAttribute('aria-expanded'), 'true')
    const first = filter.getAttribute('aria-activedescendant')
    assert.ok(first)
    assert.equal(document.getElementById(first)?.classList.contains('is-active'), true)
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const next = filter.getAttribute('aria-activedescendant')
    assert.ok(next)
    assert.notEqual(next, first)
    assert.equal(document.getElementById(next)?.textContent, 'feature/new')
    const branchOptions = [...host.querySelectorAll<HTMLButtonElement>('.branch-picker-option')]
    const [committedOption, activeOption] = branchOptions
    assert.ok(committedOption)
    assert.ok(activeOption)
    assert.equal(committedOption.getAttribute('aria-selected'), 'false')
    assert.equal(activeOption.getAttribute('aria-selected'), 'true')
    assert.equal(committedOption.classList.contains('is-selected'), true)
    filter.value = 'no-such-branch'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    assert.equal(filter.hasAttribute('aria-activedescendant'), false)
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(filter.getAttribute('aria-expanded'), 'false')
  })

  it('keeps exactly one option selected while moving from an open PR to a branch', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountFooterBranchStatus(
      host,
      store,
      createApi(
        {
          currentBranch: 'feature/with-pr',
          pr: {
            number: 12,
            title: 'Add branch footer copy',
            url: 'https://github.com/example/repo/pull/12',
          },
        },
        [
          { name: 'main', lastCommitDate: '2024-01-01' },
          { name: 'feature/with-pr', lastCommitDate: '2024-01-02' },
        ],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    const options = (): HTMLButtonElement[] => [
      ...host.querySelectorAll<HTMLButtonElement>('.branch-picker-option'),
    ]
    const selected = (): HTMLButtonElement[] =>
      options().filter((option) => option.getAttribute('aria-selected') === 'true')

    assert.equal(options()[0]?.textContent, 'Open PR #12')
    assert.equal(options()[0]?.classList.contains('is-active'), true)
    assert.equal(selected().length, 1)
    assert.equal(selected()[0]?.classList.contains('branch-picker-action'), true)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    assert.equal(options()[0]?.getAttribute('aria-selected'), 'false')
    assert.equal(options()[1]?.getAttribute('aria-selected'), 'true')
    assert.equal(selected().length, 1)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    assert.equal(options()[0]?.getAttribute('aria-selected'), 'true')
    assert.equal(options()[1]?.getAttribute('aria-selected'), 'false')
    assert.equal(selected().length, 1)
  })

  it('closes the menu on Escape and returns focus to the trigger', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi(
        { currentBranch: 'main', pr: null },
        [{ name: 'main', lastCommitDate: '2024-01-01' }],
        'main',
      ),
    )
    await settle()
    await openBranchMenu(host)

    const filter = qsRequired<HTMLInputElement>(host, '.branch-picker-filter')
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    assert.equal(host.querySelector('.branch-picker-menu')?.hasAttribute('hidden'), true)
    assert.equal(document.activeElement, qsRequired(host, '.branch-picker-trigger'))
  })

  it('refreshes from recursive working-tree events (#1753)', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const listener: { current: ((root: string) => void) | null } = { current: null }
    let branchReads = 0
    const base = createApi({ currentBranch: 'main', pr: null })
    mountFooterBranchStatus(host, store, {
      ...base,
      git: {
        ...base['git'],
        branchStatus: async () => {
          branchReads++
          return { currentBranch: branchReads === 1 ? 'main' : 'feature/external', pr: null }
        },
        onWorkingTreeChanged: (handler: (root: string) => void): (() => void) => {
          listener.current = handler
          return () => {
            if (listener.current === handler) listener.current = null
          }
        },
      },
    })
    await settle()
    assert.equal(host.querySelector('.footer-branch-label')?.textContent, 'main')
    assert.ok(listener.current)

    listener.current('/repo')
    await new Promise<void>((resolve) => setTimeout(resolve, 550))
    await settle()
    assert.equal(host.querySelector('.footer-branch-label')?.textContent, 'feature/external')
  })
})
