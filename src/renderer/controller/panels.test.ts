import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  closeRightPanelSplit,
  navigateToRoadmapItem,
  openRightPanelBeside,
  openBrowserUrl,
  openRightPanel,
  selectRightPanel,
  selectRightPanelMode,
  rightPanelShows,
  toggleFilesPane,
  toggleRightPanel,
} from './panels.ts'

function panes(store: ReturnType<typeof createStore>): [string, string | null] | null {
  const { filesPaneOpen, rightPanelMode, rightPanelSplitMode } = store.getState()
  return filesPaneOpen ? [rightPanelMode, rightPanelSplitMode] : null
}

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

  describe('split panel', () => {
    it('openRightPanelBeside stacks a second pane under the open one', () => {
      const store = createStore({ filesPaneOpen: true, rightPanelMode: 'terminal' })
      const browser: boolean[] = []
      const terminal: boolean[] = []
      selectRightPanelMode(store, 'browser', (active) => browser.push(active))
      selectRightPanelMode(store, 'terminal', (active) => terminal.push(active))

      openRightPanelBeside(store, 'browser')
      assert.deepEqual(panes(store), ['terminal', 'browser'])
      assert.ok(rightPanelShows(store.getState(), 'browser'))
      assert.ok(rightPanelShows(store.getState(), 'terminal'))
      // The open pane stays on screen; only the new one is a change.
      assert.deepEqual(browser, [true])
      assert.deepEqual(terminal, [])
    })

    it('Review always takes the top slot', () => {
      const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
      openRightPanelBeside(store, 'changes')
      assert.deepEqual(panes(store), ['changes', 'browser'])
    })

    it('opens alone when the panel is closed or the pane cannot share it', () => {
      const closed = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
      openRightPanelBeside(closed, 'browser')
      assert.deepEqual(panes(closed), ['browser', null])

      const context = createStore({ filesPaneOpen: true, rightPanelMode: 'context' })
      openRightPanelBeside(context, 'browser')
      assert.deepEqual(panes(context), ['browser', null])

      const prs = createStore({ filesPaneOpen: true, rightPanelMode: 'terminal' })
      openRightPanelBeside(prs, 'prs')
      assert.deepEqual(panes(prs), ['prs', null])
    })

    it('toggling either half closes just that half', () => {
      const store = createStore({
        filesPaneOpen: true,
        rightPanelMode: 'changes',
        rightPanelSplitMode: 'browser',
      })
      toggleRightPanel(store, 'browser')
      assert.deepEqual(panes(store), ['changes', null])

      openRightPanelBeside(store, 'browser')
      toggleRightPanel(store, 'changes')
      // The bottom pane moves up and fills the panel.
      assert.deepEqual(panes(store), ['browser', null])
    })

    it('opening a pane already in the split does not move it', () => {
      const store = createStore({
        filesPaneOpen: true,
        rightPanelMode: 'changes',
        rightPanelSplitMode: 'browser',
      })
      let panelChanges = 0
      selectRightPanel(store, () => (panelChanges += 1))
      openRightPanel(store, 'browser')
      openBrowserUrl(store, 'https://example.com/')
      assert.deepEqual(panes(store), ['changes', 'browser'])
      assert.equal(panelChanges, 0)
    })

    it('replacing the top pane keeps the bottom one; a pane that cannot share drops it', () => {
      const store = createStore({
        filesPaneOpen: true,
        rightPanelMode: 'changes',
        rightPanelSplitMode: 'browser',
      })
      openRightPanel(store, 'terminal')
      assert.deepEqual(panes(store), ['terminal', 'browser'])

      openRightPanel(store, 'context')
      assert.equal(store.getState().rightPanelMode, 'context')
      assert.equal(rightPanelShows(store.getState(), 'browser'), false)
    })

    it('closing the whole panel closes both panes', () => {
      const store = createStore({
        filesPaneOpen: true,
        rightPanelMode: 'terminal',
        rightPanelSplitMode: 'browser',
      })
      toggleFilesPane(store)
      assert.equal(panes(store), null)
      toggleFilesPane(store)
      assert.deepEqual(panes(store), ['explorer', null])
    })

    it('closeRightPanelSplit leaves the top pane filling the panel', () => {
      const store = createStore({
        filesPaneOpen: true,
        rightPanelMode: 'explorer',
        rightPanelSplitMode: 'terminal',
      })
      let panelChanges = 0
      selectRightPanel(store, () => (panelChanges += 1))
      closeRightPanelSplit(store)
      assert.deepEqual(panes(store), ['explorer', null])
      assert.equal(panelChanges, 1)
    })
  })
})
