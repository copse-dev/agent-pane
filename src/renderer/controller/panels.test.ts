import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  navigateToRoadmapItem,
  openBrowserUrl,
  openRightPanel,
  selectRightPanel,
  selectRightPanelMode,
  toggleFilesPane,
  toggleRightPanel,
} from './panels.ts'

describe('panels controller', () => {
  it('toggleFilesPane opens explorer and closes without changing mode', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    let panelChanges = 0
    selectRightPanel(store, () => (panelChanges += 1))

    toggleFilesPane(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(panelChanges, 1)

    toggleFilesPane(store)
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(panelChanges, 2)
  })

  it('openRightPanel switches mode and notifies only on a change', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let panelChanges = 0
    selectRightPanel(store, () => (panelChanges += 1))

    openRightPanel(store, 'terminal')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'terminal')
    assert.equal(panelChanges, 1)

    openRightPanel(store, 'terminal')
    assert.equal(panelChanges, 1)

    openRightPanel(store, 'changes')
    assert.equal(store.getState().rightPanelMode, 'changes')
    assert.equal(panelChanges, 2)
  })

  it('selectRightPanel ignores a mode switch while the panel is closed', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let panelChanges = 0
    selectRightPanel(store, () => (panelChanges += 1))

    store.setState({ rightPanelMode: 'terminal' })
    assert.equal(panelChanges, 0)
  })

  it('selectRightPanelMode reports when one pane comes on and off screen', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const terminal: boolean[] = []
    selectRightPanelMode(store, 'terminal', (active) => terminal.push(active))

    // Opening the closed panel on the mode is one change, not two.
    store.setState({ filesPaneOpen: true, rightPanelMode: 'terminal' })
    assert.deepEqual(terminal, [true])

    // Unrelated pane switches and a re-open of the same mode are not changes.
    openRightPanel(store, 'terminal')
    store.setState({ rightPanelMode: 'changes' })
    store.setState({ rightPanelMode: 'roadmap' })
    assert.deepEqual(terminal, [true, false])

    toggleRightPanel(store, 'terminal')
    toggleRightPanel(store, 'terminal')
    assert.deepEqual(terminal, [true, false, true, false])
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
    let panelChanges = 0
    selectRightPanel(store, () => (panelChanges += 1))

    toggleRightPanel(store, 'explorer')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(panelChanges, 1)

    toggleRightPanel(store, 'explorer')
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(panelChanges, 2)
  })

  it('toggleRightPanel opens closed panel to requested mode', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    let panelChanges = 0
    selectRightPanel(store, () => (panelChanges += 1))

    toggleRightPanel(store, 'changes')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'changes')
    assert.equal(panelChanges, 1)
  })
})
