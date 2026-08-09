import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { qsRequired } from '../dom/helpers.ts'
import {
  setRightPanelMaximized,
  toggleFilesPane,
  toggleRightPanel,
  toggleRightPanelMaximized,
} from '../controller/panels.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { RIGHT_PANEL_MAXIMIZED_CLASS, mountRightPanelLayout } from './right-panel-layout.ts'

/** The slice of index.html the expand toggle acts on. */
function mountShell(): { body: HTMLElement; paneFiles: HTMLElement; paneChat: HTMLElement } {
  document.body.innerHTML = `
    <div id="app">
      <div id="body" class="three-pane">
        <div id="pane-chat" class="pane-chat"><textarea id="composer"></textarea></div>
        <div id="pane-files" class="pane-files" hidden>
          <div id="file-tree-host"></div>
          <div id="file-viewer"></div>
        </div>
      </div>
    </div>`
  return {
    body: qsRequired(document, '#body'),
    paneFiles: qsRequired(document, '#pane-files'),
    paneChat: qsRequired(document, '#pane-chat'),
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('right panel expand-over-chat', () => {
  it('marks #body only while an open panel is expanded', () => {
    const { body } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const unmount = mountRightPanelLayout(store)

    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), false)

    toggleRightPanelMaximized(store)
    assert.equal(store.getState().rightPanelMaximized, true)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), true)

    toggleRightPanelMaximized(store)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), false)
    unmount()
  })

  it('restores chat when the expanded panel is closed, and does not re-cover it on reopen', () => {
    const { body } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const unmount = mountRightPanelLayout(store)
    setRightPanelMaximized(store, true)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), true)

    // Clicking the active panel's titlebar button closes the panel.
    toggleRightPanel(store, 'browser')
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMaximized, false)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), false)

    toggleRightPanel(store, 'browser')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), false)
    unmount()
  })

  it('clears the expanded state when the panel is toggled shut from the keyboard', () => {
    const { body } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'explorer' })
    const unmount = mountRightPanelLayout(store)
    setRightPanelMaximized(store, true)

    toggleFilesPane(store)
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(store.getState().rightPanelMaximized, false)
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), false)
    unmount()
  })

  it('keeps the panel expanded when switching between panes', () => {
    const { body } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const unmount = mountRightPanelLayout(store)
    setRightPanelMaximized(store, true)

    toggleRightPanel(store, 'terminal')
    assert.equal(store.getState().rightPanelMode, 'terminal')
    assert.equal(body.classList.contains(RIGHT_PANEL_MAXIMIZED_CLASS), true)
    unmount()
  })

  it('flips every pane header button between expand and restore', () => {
    const { paneFiles } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const browserBtn = paneMaximizeButton(store, 'browser')
    const explorerBtn = paneMaximizeButton(store, 'explorer')
    paneFiles.append(browserBtn, explorerBtn)
    const unmount = mountRightPanelLayout(store)

    assert.equal(browserBtn.getAttribute('aria-label'), 'Expand browser over chat')
    assert.equal(browserBtn.getAttribute('aria-pressed'), 'false')

    browserBtn.click()
    assert.equal(store.getState().rightPanelMaximized, true)
    assert.equal(browserBtn.getAttribute('aria-label'), 'Restore browser')
    assert.equal(browserBtn.getAttribute('aria-pressed'), 'true')
    // The header of every pane carries the toggle, so all of them must agree.
    assert.equal(explorerBtn.getAttribute('aria-label'), 'Restore explorer')

    // The same button is the way back.
    browserBtn.click()
    assert.equal(store.getState().rightPanelMaximized, false)
    assert.equal(browserBtn.getAttribute('aria-label'), 'Expand browser over chat')
    assert.equal(explorerBtn.getAttribute('aria-pressed'), 'false')
    unmount()
  })

  it('starts a late-mounting pane header on the restore face', () => {
    const { paneFiles } = mountShell()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'changes' })
    const unmount = mountRightPanelLayout(store)
    setRightPanelMaximized(store, true)

    // Changes / PRs mount once Monaco resolves — after the panel was expanded.
    const changesBtn = paneMaximizeButton(store, 'changes')
    paneFiles.append(changesBtn)
    assert.equal(changesBtn.getAttribute('aria-label'), 'Restore changes')
    assert.equal(changesBtn.getAttribute('aria-pressed'), 'true')
    unmount()
  })

  it('drops focus from the covered composer when the panel expands', () => {
    const { paneChat } = mountShell()
    const composer = qsRequired<HTMLTextAreaElement>(paneChat, '#composer')
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'terminal' })
    const unmount = mountRightPanelLayout(store)

    composer.focus()
    assert.equal(document.activeElement, composer)

    setRightPanelMaximized(store, true)
    assert.notEqual(document.activeElement, composer)
    unmount()
  })
})
