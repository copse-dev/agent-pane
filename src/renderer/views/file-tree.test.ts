import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountFileTree } from './file-tree.ts'
import { createThread, setThreadTitle } from '@shared/store/thread-helpers.ts'
import { __resetPersistenceForTest, attachAutosave } from '../controller/persistence.ts'
import { makeThread } from '../thread-fixture.test-support.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeApi(previewRequests: string[]): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    browser: {
      ...base.browser,
      workspaceFileUrl: async (_projectId, _threadId, path): Promise<string> => {
        previewRequests.push(path)
        return `http://localhost:4173/${path}`
      },
    },
    fs: {
      ...base.fs,
      listDir: async () => [{ name: 'guide.html', isDir: false }],
    },
  }
}

function localStore(): ReturnType<typeof createStore> {
  return createStore({
    workspaceRoot: '/workspace',
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    projects: [{ id: 'project-1', name: 'workspace', path: '/workspace' }],
    filesPaneOpen: true,
  })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('file tree selection', () => {
  it('shows checkout recovery guidance without exposing Electron transport details', async () => {
    const store = localStore()
    const base = makeApi([])
    const api: ApiClient = {
      ...base,
      fs: {
        ...base.fs,
        listDir: async () => {
          throw new Error(
            "Error invoking remote method 'fs:list-dir': Error: Checkout unavailable. Resume this chat to restore it.",
          )
        },
      },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, api)
    await tick()
    assert.equal(
      root.querySelector('.sidebar-empty')?.textContent,
      'Checkout unavailable. Resume this chat to restore it.',
    )
    assert.equal(root.querySelector('.tree-row'), null)
    unmount()
  })

  it('selects the open file when the store opens it, with no event', async () => {
    const store = localStore()
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, makeApi([]))
    await tick()
    const row = root.querySelector<HTMLButtonElement>('.tree-row[title="guide.html"]')
    assert.ok(row)
    assert.equal(row.classList.contains('selected'), false)

    store.setState({ openFile: { path: 'guide.html', content: '', language: 'html' } })
    await tick()

    assert.equal(row.classList.contains('selected'), true)
    unmount()
  })
})

describe('file tree thread scope', () => {
  it('reloads for a newly selected thread from setState alone, not for thread metadata', async () => {
    const store = createStore({
      workspaceRoot: '/workspace',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projects: [{ id: 'project-1', name: 'workspace', path: '/workspace' }],
      threads: [makeThread({ id: 'thread-1' }), makeThread({ id: 'thread-2' })],
      filesPaneOpen: true,
    })
    const listed: string[] = []
    const base = makeApi([])
    const api: ApiClient = {
      ...base,
      fs: {
        ...base.fs,
        listDir: async (_projectId, threadId) => {
          listed.push(threadId)
          return [{ name: `${threadId}.ts`, isDir: false }]
        },
      },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, api)
    await tick()
    assert.deepEqual(listed, ['thread-1'])
    const row = root.querySelector('.tree-row[title="thread-1.ts"]')
    assert.ok(row)

    setThreadTitle(store, 'thread-1', 'Renamed')
    setThreadTitle(store, 'thread-2', 'Another thread')
    store.emit('threads_changed')
    await tick()
    assert.deepEqual(listed, ['thread-1'], 'renames and other threads do not reload the tree')
    assert.equal(root.querySelector('.tree-row[title="thread-1.ts"]'), row)

    store.setState({ activeThreadId: 'thread-2' })
    await tick()
    assert.deepEqual(listed, ['thread-1', 'thread-2'])
    assert.ok(root.querySelector('.tree-row[title="thread-2.ts"]'))
    unmount()
  })
})

describe('file tree browser context menu', () => {
  it('opens a local file in the built-in browser without opening the file viewer first', async () => {
    const store = localStore()
    const previewRequests: string[] = []
    const browserUrls: string[] = []
    store.on('browser_url_requested', (url) => browserUrls.push(url))
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, makeApi(previewRequests))
    await tick()

    const row = root.querySelector<HTMLButtonElement>('.tree-row[title="guide.html"]')
    assert.ok(row)
    row.dispatchEvent(
      new window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 36,
      }),
    )

    const item = document.querySelector<HTMLButtonElement>('.context-menu-item')
    assert.ok(item)
    assert.equal(item.textContent, 'Open in browser')
    assert.equal(store.getState().openFile, null, 'right-click must not open the file viewer')
    item.click()
    await tick()

    assert.deepEqual(previewRequests, ['guide.html'])
    assert.deepEqual(browserUrls, ['http://localhost:4173/guide.html'])
    assert.equal(store.getState().rightPanelMode, 'browser')
    unmount()
  })

  it('does not offer browser opening for an SSH workspace file', async () => {
    const store = localStore()
    store.setState({
      projects: [{ id: 'project-1', name: 'dev:/workspace', path: '/workspace', sshHost: 'dev' }],
    })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, makeApi([]))
    await tick()

    const row = root.querySelector<HTMLButtonElement>('.tree-row[title="guide.html"]')
    assert.ok(row)
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    row.dispatchEvent(event)

    assert.equal(event.defaultPrevented, false)
    assert.equal(document.querySelector('.context-menu'), null)
    unmount()
  })
})

describe('file tree workspace switch', () => {
  it('reloads the root listing when setState alone switches projects', async () => {
    const lists: string[] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      fs: {
        ...base.fs,
        listDir: async (projectId, threadId, dirPath) => {
          lists.push(`${projectId}/${threadId}:${dirPath}`)
          return [{ name: `${projectId}.md`, isDir: false }]
        },
      },
    }
    const store = localStore()
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, api)
    await tick()
    assert.ok(root.querySelector('.tree-row[title="project-1.md"]'))

    store.setState({
      activeProjectId: 'project-2',
      activeThreadId: 'thread-2',
      workspaceRoot: '/other',
      projects: [
        { id: 'project-1', name: 'workspace', path: '/workspace' },
        { id: 'project-2', name: 'other', path: '/other' },
      ],
    })
    await tick()

    assert.deepEqual(lists, ['project-1/thread-1:', 'project-2/thread-2:'])
    assert.ok(root.querySelector('.tree-row[title="project-2.md"]'), 'the new project’s entries')
    assert.equal(root.querySelector('.tree-row[title="project-1.md"]'), null)
    unmount()
  })
})

describe('file tree and thread persistence', () => {
  it('lists a new thread only after autosave has created it in main', async () => {
    __resetPersistenceForTest()
    const store = createStore({
      workspaceRoot: '/workspace',
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'workspace', path: '/workspace' }],
      filesPaneOpen: true,
    })
    const base = createFakeApi()
    const created = new Set<string>()
    let releaseCreate: (() => void) | undefined
    const listed: string[] = []
    const api: ApiClient = {
      ...base,
      threads: {
        ...base.threads,
        create: (_projectId, thread) =>
          new Promise<void>((resolve) => {
            releaseCreate = (): void => {
              created.add(thread.id)
              resolve()
            }
          }),
      },
      fs: {
        ...base.fs,
        // Main rejects a thread whose meta is not on disk yet.
        listDir: async (_projectId, threadId) => {
          listed.push(threadId)
          if (!created.has(threadId)) throw new Error('Thread is not persisted yet')
          return [{ name: 'guide.html', isDir: false }]
        },
      },
    }
    const autosave = attachAutosave(store, api)
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = mountFileTree(root, store, api)
    try {
      // The selection fires inside createThread's setState, before the
      // threads_changed that starts the create.
      const id = createThread(store)
      await tick()
      assert.deepEqual(listed, [], 'no listing while the create is in flight')

      releaseCreate?.()
      await tick()
      assert.deepEqual(listed, [id])
      assert.ok(root.querySelector('.tree-row[title="guide.html"]'))
    } finally {
      unmount()
      autosave.detach()
    }
  })
})
