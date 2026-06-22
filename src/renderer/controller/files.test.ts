import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { detectLanguage, openWorkspaceFile } from './files.ts'

function apiWithFile(content: string): ApiClient {
  return {
    fs: {
      readFile: async () => content,
    },
  } as unknown as ApiClient
}

describe('files controller', () => {
  it('detects common Monaco languages from filenames', () => {
    assert.equal(detectLanguage('src/app.tsx'), 'typescript')
    assert.equal(detectLanguage('Dockerfile'), 'dockerfile')
    assert.equal(detectLanguage('unknown.ext'), 'plaintext')
  })

  it('opens a workspace file in the explorer panel', async () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
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
})
