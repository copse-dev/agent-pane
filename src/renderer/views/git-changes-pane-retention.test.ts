import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function changed(prefix: string): GitStatusResult {
  return {
    staged: [],
    unstaged: [
      { path: `${prefix}-first.ts`, status: 'modified' },
      { path: `${prefix}-second.ts`, status: 'modified' },
    ],
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const cleanups: Array<() => void> = []

function mount(status: ApiClient['git']['status']): {
  store: AppStore
  listRoot: HTMLElement
  viewerRoot: HTMLElement
} {
  const store = createStore({
    workspaceRoot: '/project',
    activeProjectId: 'project-1',
    activeThreadId: 'a',
    threads: [thread('a'), thread('b')],
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    git: {
      ...base.git,
      isAvailable: async () => true,
      status,
      committedChanges: async () => null,
      sessionBackup: async () => null,
      fileDiff: async () => null,
    },
  }
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  cleanups.push(mountGitChangesPane(listRoot, viewerRoot, store, api, null))
  return { store, listRoot, viewerRoot }
}

function paths(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.git-change-path')].map((row) => row.textContent)
}

before(() => {
  if (!('ResizeObserver' in globalThis)) {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver
  }
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup()
  })
  document.body.replaceChildren()
})

describe('Changes pane retains known thread state', () => {
  it('keeps the selected file and DOM on an unrelated thread-list update without rereading Git', async () => {
    let calls = 0
    const { store, listRoot } = mount(async () => {
      calls++
      return changed('a')
    })
    await settle()
    const second = listRoot.querySelectorAll<HTMLButtonElement>('.git-change-row')[1]
    assert.ok(second)
    second.click()
    await settle()
    const selected = listRoot.querySelector('.git-change-row.is-selected')
    assert.ok(selected)

    store.setState({
      threads: store
        .getState()
        .threads.map((item) => (item.id === 'b' ? { ...item, title: 'Renamed elsewhere' } : item)),
    })
    store.emit('threads_changed')
    await settle()

    assert.equal(calls, 1)
    assert.equal(listRoot.querySelector('.git-change-row.is-selected'), selected)
    assert.match(selected.textContent, /a-second.ts/)
  })

  it('restores a returning thread immediately while revalidating its status', async () => {
    let aCalls = 0
    let resolveA: ((status: GitStatusResult) => void) | undefined
    const { store, listRoot } = mount(async (_projectId, threadId) => {
      if (threadId !== 'a') return changed('b')
      if (++aCalls === 1) return changed('a')
      return new Promise<GitStatusResult>((resolve) => {
        resolveA = resolve
      })
    })
    await settle()
    const second = listRoot.querySelectorAll<HTMLButtonElement>('.git-change-row')[1]
    assert.ok(second)
    second.click()
    await settle()

    store.setState({ activeThreadId: 'b' })
    store.emit('panel_changed')
    store.emit('threads_changed')
    await settle()
    assert.deepEqual(paths(listRoot), ['b-first.ts', 'b-second.ts'])

    store.setState({ activeThreadId: 'a' })
    store.emit('threads_changed')
    await settle()
    assert.deepEqual(paths(listRoot), ['a-first.ts', 'a-second.ts'])
    assert.equal(listRoot.querySelector('.pane-loading'), null)
    assert.match(listRoot.querySelector('.is-selected')?.textContent ?? '', /a-second.ts/)

    resolveA?.(changed('updated-a'))
    await settle()
    assert.deepEqual(paths(listRoot), ['updated-a-first.ts', 'updated-a-second.ts'])
  })

  it('clears another owner immediately and ignores its late response while hidden', async () => {
    let resolveB: ((status: GitStatusResult) => void) | undefined
    const { store, listRoot } = mount(async (_projectId, threadId) => {
      if (threadId === 'a') return changed('a')
      return new Promise<GitStatusResult>((resolve) => {
        resolveB = resolve
      })
    })
    await settle()
    store.setState({ activeThreadId: 'b' })
    store.emit('threads_changed')
    assert.deepEqual(paths(listRoot), [], 'a different owner must not show the previous files')
    await settle()

    store.setState({ activeThreadId: 'a', filesPaneOpen: false })
    store.emit('threads_changed')
    resolveB?.(changed('late-b'))
    await settle()
    assert.deepEqual(paths(listRoot), ['a-first.ts', 'a-second.ts'])
  })

  it('does not reuse a cached snapshot after the same thread gets a different worktree', async () => {
    let calls = 0
    const { store, listRoot } = mount(async () => {
      if (++calls === 1) return changed('shared')
      return new Promise<GitStatusResult>(() => {})
    })
    await settle()
    store.setState({
      threads: store.getState().threads.map((item) =>
        item.id === 'a'
          ? {
              ...item,
              worktree: {
                path: '/isolated/a',
                branch: 'feature/a',
                baseBranch: 'main',
                baseCommit: 'abc',
                createdAt: 2,
                seededFromDirtyProject: false,
              },
            }
          : item,
      ),
    })
    store.emit('threads_changed')
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(paths(listRoot), [])
    assert.ok(listRoot.querySelector('.pane-loading'))
  })

  it('does not carry a queued file navigation into another thread with the same file paths', async () => {
    const { store, listRoot } = mount(async () => changed('shared'))
    await settle()
    store.setState({ activeThreadId: 'b' })
    store.emit('threads_changed')
    await settle()
    store.setState({ activeThreadId: 'a' })
    store.emit('threads_changed')
    await settle()
    store.setState({ filesPaneOpen: false })
    store.emit('git_change_navigate', 'shared-second.ts')

    store.setState({ activeThreadId: 'b', filesPaneOpen: true })
    store.emit('panel_changed')
    store.emit('threads_changed')
    await settle()
    assert.match(listRoot.querySelector('.is-selected')?.textContent ?? '', /shared-first.ts/)
  })
})
