import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'
import { openWorkspaceFile } from './files.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'

const IMAGE = 'data:image/png;base64,iVBORw0KGgo='

describe('workspace image links', () => {
  before(patchPreviewDialog)
  afterEach(() => {
    dismissContextMenu()
    document.querySelector<HTMLDialogElement>('dialog[open]')?.close()
    document.body.replaceChildren()
  })

  it('opens image bytes in the shared preview without reading them as text', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let textReads = 0
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readFile: async (): Promise<string> => {
          textReads += 1
          return 'binary garbage'
        },
        readImage: async (projectId: string, threadId: string, path: string): Promise<string> => {
          assert.deepEqual(
            [projectId, threadId, path],
            ['project-1', 'thread-1', 'images/chart.PNG'],
          )
          return IMAGE
        },
      },
    }
    await openWorkspaceFile(store, api, 'images/chart.PNG')
    assert.equal(textReads, 0)
    assert.equal(store.getState().openFile, null)
    assert.equal(document.querySelector('.image-expand-image')?.getAttribute('src'), IMAGE)
    assert.equal(
      document.querySelector('dialog[open]')?.getAttribute('aria-label'),
      'Image preview: images/chart.PNG',
    )
    const image = document.querySelector<HTMLImageElement>('.image-expand-image')
    assert.ok(image)
    const contextEvent = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    image.dispatchEvent(contextEvent)
    assert.equal(contextEvent.defaultPrevented, true)
    assert.equal(
      document.querySelector('dialog[open] .context-menu-item')?.textContent,
      'Copy image',
    )
  })

  it('does not reopen a preview dismissed while its image was loading', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let resolve: (image: string) => void = () => undefined
    const image = new Promise<string>((done) => {
      resolve = done
    })
    const api = { ...base, fs: { ...base.fs, readImage: (): Promise<string> => image } }
    const pending = openWorkspaceFile(store, api, 'chart.png')
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
    assert.ok(dialog)
    dialog.close()
    resolve(IMAGE)
    await pending
    assert.equal(document.querySelector('dialog[open]'), null)
    assert.equal(document.querySelector('.image-expand-image'), null)
  })

  it('invalidates a pending image when the task changes and returns', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let resolve: (image: string) => void = () => undefined
    const image = new Promise<string>((done) => {
      resolve = done
    })
    const api = { ...base, fs: { ...base.fs, readImage: (): Promise<string> => image } }
    const pending = openWorkspaceFile(store, api, 'chart.png')
    store.setState({ activeThreadId: 'thread-2' })
    store.emit('panel_changed')
    store.setState({ activeThreadId: 'thread-1' })
    store.emit('panel_changed')
    resolve(IMAGE)
    await pending
    assert.equal(document.querySelector('dialog[open]'), null)
    assert.equal(store.getState().openFile, null)
  })

  it('keeps a newer preview when an earlier read finishes last', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let resolve: (image: string) => void = () => undefined
    const oldImage = new Promise<string>((done) => {
      resolve = done
    })
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (_projectId: string, _threadId: string, path: string): Promise<string> =>
          path === 'old.png' ? oldImage : Promise.resolve(IMAGE),
      },
    }
    const pending = openWorkspaceFile(store, api, 'old.png')
    await openWorkspaceFile(store, api, 'new.png')
    resolve('data:image/png;base64,b2xk')
    await pending
    assert.equal(document.querySelector('.image-expand-image')?.getAttribute('src'), IMAGE)
    assert.equal(document.querySelector('.attachment-preview-title')?.textContent, 'new.png')
  })

  it('shows a read error in the preview and closes when its checkout changes', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (): Promise<string> => Promise.reject(new Error('file is too large')),
      },
    }
    await openWorkspaceFile(store, api, 'chart.png')
    assert.match(
      document.querySelector('.attachment-preview-status')?.textContent ?? '',
      /file is too large/,
    )
    store.emit('thread_checkout_changed', 'thread-1')
    assert.equal(document.querySelector('dialog[open]'), null)
  })

  it('retains source navigation for an SVG line reference', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    const api = { ...base, fs: { ...base.fs, readFile: async (): Promise<string> => '<svg />' } }
    await openWorkspaceFile(store, api, 'chart.svg', { line: 2 })
    assert.equal(store.getState().openFile?.content, '<svg />')
    assert.deepEqual(store.getState().openFile?.reveal, { line: 2 })
    assert.equal(document.querySelector('dialog[open]'), null)
  })
})
