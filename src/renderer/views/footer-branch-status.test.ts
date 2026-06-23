import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitBranchStatus } from '@shared/types/git.ts'
import { mountFooterBranchStatus } from './footer-branch-status.ts'

function thread(branch?: string): Thread {
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
  return value
}

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  })
}

function createApi(status: GitBranchStatus): ApiClient {
  return {
    fs: { onChanged: () => () => {} },
    git: { branchStatus: async () => status },
  } as unknown as ApiClient
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('footer branch status', () => {
  it('copies the thread branch when there is no pull request link', async () => {
    let copiedBranch: string | null = null
    installClipboard(async (text) => {
      copiedBranch = text
    })

    const store = createStore({
      workspaceRoot: '/repo',
      activeThreadId: 'thread-1',
      threads: [thread('feature/footer-copy')],
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(host, store, createApi({ currentBranch: 'main', pr: null }))
    await settle()

    const button = host.querySelector<HTMLButtonElement>('.footer-branch-status')!
    assert.equal(button.textContent, 'feature/footer-copy')
    assert.ok(button.classList.contains('is-copyable'))

    button.click()
    await settle()

    assert.equal(copiedBranch, 'feature/footer-copy')
    assert.equal(document.querySelector('.toast')?.textContent, 'Copied branch name')
  })

  it('opens the pull request in the in-app browser pane instead of copying when a PR link is present', async () => {
    let copiedBranch: string | null = null
    let requestedUrl: string | null = null
    installClipboard(async (text) => {
      copiedBranch = text
    })

    const store = createStore({
      workspaceRoot: '/repo',
      activeThreadId: 'thread-1',
      threads: [thread('feature/with-pr')],
    })
    store.on('browser_url_requested', (url) => {
      requestedUrl = url
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountFooterBranchStatus(
      host,
      store,
      createApi({
        currentBranch: 'feature/with-pr',
        pr: {
          number: 12,
          title: 'Add branch footer copy',
          url: 'https://github.com/example/repo/pull/12',
        },
      }),
    )
    await settle()

    const button = host.querySelector<HTMLButtonElement>('.footer-branch-status')!
    assert.equal(button.textContent, 'PR #12')
    assert.ok(button.classList.contains('is-link'))
    assert.ok(!button.classList.contains('is-copyable'))

    button.click()
    await settle()

    assert.equal(requestedUrl, 'https://github.com/example/repo/pull/12')
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(copiedBranch, null)
  })
})
