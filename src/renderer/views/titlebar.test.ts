import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountTitlebar } from './titlebar.ts'
import { createThread, setThreadTitle } from '@shared/store/thread-helpers.ts'
import { __resetPersistenceForTest, attachAutosave } from '../controller/persistence.ts'

function thread(id: string, branch: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    gitBranch: branch,
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('titlebar branch status', () => {
  it('coalesces same-thread events but refreshes a visible thread switch immediately', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      threads: [thread('thread-1', 'main'), thread('thread-2', 'feature/two')],
    })
    const root = document.createElement('div')
    document.body.append(root)
    let branchReads = 0
    let remoteReads = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: {
        ...base['git'],
        branchStatus: async () => {
          remoteReads += 1
          return { currentBranch: null, pr: null }
        },
        currentBranch: async () => {
          branchReads += 1
          return store.getState().activeThreadId === 'thread-1' ? 'main' : 'feature/two'
        },
      },
    }

    let destroy: (() => void) | undefined
    try {
      destroy = mountTitlebar(root, store, api)
      await settle()
      assert.equal(branchReads, 1)
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'main')

      store.emit('git_branch_changed')
      await settle()
      assert.equal(branchReads, 1, 'same-thread events do not start competing Git reads')

      await new Promise<void>((resolve) => setTimeout(resolve, 550))
      await settle()
      assert.equal(branchReads, 2, 'the event burst resolves to one deferred refresh')

      store.setState({ activeThreadId: 'thread-2' })
      await settle()
      assert.equal(remoteReads, 0, 'titlebar background refreshes never query PR status')
      assert.equal(branchReads, 3, 'a visible thread switch does not wait for the debounce')
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'feature/two')

      // Another thread's rename (which still emits threads_changed) is not a
      // branch change for this thread: no deferred Git read follows.
      setThreadTitle(store, 'thread-1', 'Renamed elsewhere')
      await new Promise<void>((resolve) => setTimeout(resolve, 550))
      await settle()
      assert.equal(branchReads, 3, "another thread's rename starts no Git read")
    } finally {
      destroy?.()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('titlebar sidebar toggle', () => {
  it('repaints from projectsPaneOpen alone, with no event emitted', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const body = document.createElement('div')
    body.id = 'body'
    const root = document.createElement('div')
    document.body.append(body, root)
    const store = createStore()

    let destroy: (() => void) | undefined
    try {
      destroy = mountTitlebar(root, store, createFakeApi())
      const button = root.querySelector('.titlebar-sidebar-btn')
      assert.ok(button)
      assert.equal(button.getAttribute('aria-pressed'), 'true')
      assert.equal(body.classList.contains('is-projects-collapsed'), false)

      store.setState({ projectsPaneOpen: false })
      assert.equal(button.getAttribute('aria-pressed'), 'false')
      assert.equal(body.classList.contains('is-projects-collapsed'), true)

      store.setState({ projectsPaneOpen: true })
      assert.equal(button.getAttribute('aria-pressed'), 'true')
      assert.equal(body.classList.contains('is-projects-collapsed'), false)
    } finally {
      destroy?.()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('titlebar workspace switch', () => {
  it('repaints the project name and re-syncs the branch from setState alone', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projects: [
        { id: 'project-1', name: 'First', path: '/repo' },
        { id: 'project-2', name: 'Second', path: '/other' },
      ],
      threads: [thread('thread-1', 'main')],
    })
    const root = document.createElement('div')
    document.body.append(root)
    const branchReads: string[] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: {
        ...base['git'],
        currentBranch: async (projectId) => {
          branchReads.push(projectId)
          return projectId === 'project-1' ? 'main' : 'feature/second'
        },
      },
    }

    let destroy: (() => void) | undefined
    try {
      destroy = mountTitlebar(root, store, api)
      await settle()
      assert.equal(root.querySelector('.workspace-name-label')?.textContent, 'First')
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'main')
      assert.deepEqual(branchReads, ['project-1'])

      // No store event: the selection alone must reach the titlebar.
      store.setState({ activeProjectId: 'project-2', workspaceRoot: '/other' })
      assert.equal(root.querySelector('.workspace-name-label')?.textContent, 'Second')
      await settle()
      assert.deepEqual(branchReads, ['project-1', 'project-2'], 'no debounce wait')
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'feature/second')
    } finally {
      destroy?.()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('titlebar and thread persistence', () => {
  it('reads the branch and Run App of a new thread only after autosave creates it', async () => {
    __resetPersistenceForTest()
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'First', path: '/repo' }],
    })
    const created = new Set<string>()
    let releaseCreate: (() => void) | undefined
    const base = createFakeApi()
    const notPersisted = (threadId: string | undefined): boolean =>
      threadId !== undefined && !created.has(threadId)
    const api: ApiClient = {
      ...base,
      threads: {
        ...base['threads'],
        create: (_projectId, created_) =>
          new Promise<void>((resolve) => {
            releaseCreate = (): void => {
              created.add(created_.id)
              resolve()
            }
          }),
      },
      git: {
        ...base['git'],
        // Main rejects a thread whose meta is not on disk yet.
        currentBranch: async (_projectId, threadId) => {
          if (notPersisted(threadId)) throw new Error('Thread is not persisted yet')
          return 'main'
        },
      },
      appRun: {
        ...base['appRun'],
        detect: async ({ threadId }) => {
          if (notPersisted(threadId)) throw new Error('Thread is not persisted yet')
          return true
        },
      },
    }
    const autosave = attachAutosave(store, api)
    const root = document.createElement('div')
    document.body.append(root)
    let destroy: (() => void) | undefined
    try {
      destroy = mountTitlebar(root, store, api)
      await settle()
      createThread(store)
      await settle()
      releaseCreate?.()
      await settle()
      const branch = root.querySelector<HTMLElement>('.workspace-branch')
      assert.ok(branch)
      assert.equal(branch.hidden, false, 'the branch label shows for the new thread')
      assert.equal(branch.textContent, 'main')
      const runApp = root.querySelector<HTMLElement>('.titlebar-run-app')
      assert.ok(runApp)
      assert.equal(runApp.hidden, false, 'Run App shows for the new thread')
    } finally {
      destroy?.()
      autosave.detach()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
