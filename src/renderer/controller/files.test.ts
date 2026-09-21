import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { qs, qsRequired } from '../dom/helpers.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'
import { activateWorkspaceReference, detectLanguage, openWorkspaceFile } from './files.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function apiWithFile(content: string): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      fs: {
        ...base['fs'],
        readFile: async (projectId: string, threadId: string, path: string): Promise<string> => {
          assert.equal(projectId, 'project-1')
          assert.equal(threadId, 'thread-1')
          assert.equal(path, 'README.md')
          return content
        },
      },
    } satisfies ApiClient
  })()
}

function apiWithImage(dataUrl: string | null): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      fs: {
        ...base['fs'],
        readFile: async (): Promise<string> => {
          throw new Error('readFile should not be used for an image path')
        },
        readImage: async (
          projectId: string,
          threadId: string,
          path: string,
        ): Promise<string | null> => {
          assert.equal(projectId, 'project-1')
          assert.equal(threadId, 'thread-1')
          assert.equal(path, 'screenshot.png')
          return dataUrl
        },
      },
    } satisfies ApiClient
  })()
}

describe('files controller', () => {
  before(() => {
    patchPreviewDialog()
  })

  it('detects common Monaco languages from filenames', () => {
    assert.equal(detectLanguage('src/app.tsx'), 'typescript')
    assert.equal(detectLanguage('Dockerfile'), 'dockerfile')
    assert.equal(detectLanguage('unknown.ext'), 'plaintext')
  })

  it('opens a workspace file in the explorer panel', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
    let panelEvents = 0
    let paneEvents = 0
    let modeEvents = 0
    store.on('panel_changed', () => (panelEvents += 1))
    store.on('files_pane_changed', () => (paneEvents += 1))
    store.on('right_panel_mode_changed', () => (modeEvents += 1))

    await openWorkspaceFile(store, apiWithFile('# Readme\n'), 'README.md')

    assert.deepEqual(store.getState().openFile, {
      path: 'README.md',
      content: '# Readme\n',
      language: 'markdown',
    })
    assert.equal(store.getState().panelTab, 'file')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(panelEvents, 1)
    assert.equal(paneEvents, 1)
    assert.equal(modeEvents, 1)
  })

  it('activating an image file reference opens the image lightbox, not the text file viewer', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
    const panelTabBefore = store.getState().panelTab

    await activateWorkspaceReference(store, apiWithImage(PNG), 'screenshot.png', 'file')

    // The file viewer must stay closed: an image is never routed through the
    // text/Monaco panel (which would decode its bytes as garbled text).
    assert.equal(store.getState().openFile, null)
    assert.equal(store.getState().panelTab, panelTabBefore)
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMode, 'terminal')

    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog.open, true)
    const expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, PNG)
    dialog.close()
  })

  it('rejects when the image cannot be read, without falling back to the text viewer', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })

    await assert.rejects(
      activateWorkspaceReference(store, apiWithImage(null), 'screenshot.png', 'file'),
    )
    assert.equal(store.getState().openFile, null)
    const dialog = qs<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog?.open ?? false, false)
  })
})
