import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountFileTree } from './file-tree.ts'

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
