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

    let releaseStale: ((value: GitBranchInfo[]) => void) | null = null
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

    releaseStale?.([{ name: 'feature/stale', lastCommitDate: '2024-01-03' }])
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
})
