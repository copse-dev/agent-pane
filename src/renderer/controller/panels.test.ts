import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  navigateToRoadmapItem,
  openBrowserUrl,
  openRightPanel,
  toggleFilesPane,
  toggleRightPanel,
} from './panels.ts'

describe('panels controller', () => {
  it('toggleFilesPane opens explorer and closes without changing mode', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    const paneEvents: number[] = []
    const modeEvents: number[] = []
    store.on('files_pane_changed', () => paneEvents.push(1))
    store.on('right_panel_mode_changed', () => modeEvents.push(1))

    toggleFilesPane(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(paneEvents.length, 1)
    assert.equal(modeEvents.length, 1)

    toggleFilesPane(store)
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(paneEvents.length, 2)
    assert.equal(modeEvents.length, 1)
  })

  it('openRightPanel switches mode and emits when needed', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let modeEvents = 0
    store.on('right_panel_mode_changed', () => (modeEvents += 1))

    openRightPanel(store, 'terminal')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'terminal')
    assert.equal(modeEvents, 1)

    openRightPanel(store, 'terminal')
    assert.equal(modeEvents, 1)

    openRightPanel(store, 'changes')
    assert.equal(store.getState().rightPanelMode, 'changes')
    assert.equal(modeEvents, 2)
  })

  it('openBrowserUrl opens the browser panel and emits the URL request', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))

    openBrowserUrl(store, 'https://example.com/docs')

    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, ['https://example.com/docs'])
  })

  it('navigateToRoadmapItem opens the roadmap panel, then emits the reveal', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const revealed: string[] = []
    // The pane must already see roadmap mode when the reveal lands, so record
    // the mode at emit time to pin the ordering.
    const modesAtReveal: string[] = []
    store.on('roadmap_reveal', (id) => {
      revealed.push(id)
      modesAtReveal.push(store.getState().rightPanelMode)
    })

    navigateToRoadmapItem(store, 'item-42')

    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'roadmap')
    assert.deepEqual(revealed, ['item-42'])
    assert.deepEqual(modesAtReveal, ['roadmap'])
  })

  it('toggleRightPanel switches to requested mode before closing active mode', () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'terminal' })
    const paneEvents: number[] = []
    const modeEvents: number[] = []
    store.on('files_pane_changed', () => paneEvents.push(1))
    store.on('right_panel_mode_changed', () => modeEvents.push(1))

    toggleRightPanel(store, 'explorer')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(paneEvents.length, 1)
    assert.equal(modeEvents.length, 1)

    toggleRightPanel(store, 'explorer')
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(paneEvents.length, 2)
    assert.equal(modeEvents.length, 1)
  })

  it('toggleRightPanel opens closed panel to requested mode', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    const paneEvents: number[] = []
    const modeEvents: number[] = []
    store.on('files_pane_changed', () => paneEvents.push(1))
    store.on('right_panel_mode_changed', () => modeEvents.push(1))

    toggleRightPanel(store, 'changes')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'changes')
    assert.equal(paneEvents.length, 1)
    assert.equal(modeEvents.length, 1)
  })
})
