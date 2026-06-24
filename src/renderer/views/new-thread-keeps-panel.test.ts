import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { mountRightPanelTabs } from './right-panel-tabs.ts'
import { syncFilesPaneDom, toggleRightPanel } from '../controller/panels.ts'

// Component-level port of tests/e2e/new-thread-keeps-panel.e2e.ts. That spec is
// CI-quarantined for a new-thread `$$` race, yet everything it asserts — the
// chats-list rows, #pane-files visibility, and the active right-panel tab — is
// DOM/store with no Electron runtime. So it runs here in happy-dom against the
// real projects-pane / right-panel-tabs views and the openNewThread controller
// path, guarding the same regression (creating a new thread must not close the
// side panel) without launching the app.

function seededThread(): Thread {
  return {
    id: 't-existing',
    title: 'Existing chat',
    status: 'idle',
    messages: [
      { id: 't-existing-msg', role: 'user', content: 'hello', toolCalls: [], createdAt: 1 },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

// The new-thread click path (project active + workspace set → openNewThread)
// never touches the api, so a bare stub is enough.
const apiStub = {} as unknown as ApiClient

afterEach(() => {
  document.body.replaceChildren()
})

describe('new thread keeps the side panel open (component)', () => {
  it('adds a selected New Thread row while #pane-files and the Explorer tab stay active', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [seededThread()],
      activeThreadId: 't-existing',
      filesPaneOpen: false,
      rightPanelMode: 'explorer',
    })

    const projectsHost = document.createElement('div')
    const tabsHost = document.createElement('div')
    const pane = document.createElement('div')
    pane.id = 'pane-files'
    pane.hidden = true
    document.body.append(projectsHost, tabsHost, pane)
    mountProjectsPane(projectsHost, store, apiStub)
    mountRightPanelTabs(tabsHost, store)

    const chatRows = () => document.querySelectorAll('.chats-list .chat-row')
    const explorerTab = () =>
      document.querySelector('.right-panel-tab[aria-label="Explorer"]') as HTMLElement

    // One seeded thread, panel closed.
    assert.equal(chatRows().length, 1)
    assert.equal(pane.hidden, true)

    // Open the right panel (explorer) — mirrors clicking the titlebar toggle.
    toggleRightPanel(store, 'explorer')
    syncFilesPaneDom(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(pane.hidden, false)
    assert.ok(explorerTab().classList.contains('is-active'))

    // Create a new thread from the expanded project row.
    document.querySelector<HTMLButtonElement>('.project-new-thread-btn')!.click()

    // A fresh blank thread is added and selected.
    assert.equal(chatRows().length, 2)
    assert.equal(
      document.querySelector('.chat-row.selected .chat-title')?.textContent,
      'New Thread',
    )

    // The panel stays open in the same mode on the new thread.
    syncFilesPaneDom(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(pane.hidden, false)
    assert.ok(explorerTab().classList.contains('is-active'))
  })
})
