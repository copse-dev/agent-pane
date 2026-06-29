import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { syncFilesPaneDom, toggleRightPanel } from '../controller/panels.ts'

// Component-level port of tests/e2e/new-thread-keeps-panel.e2e.ts. That spec is
// CI-quarantined for a new-thread `$$` race, yet everything it asserts — the
// chats-list rows and the side panel staying open in the same mode — is
// DOM/store with no Electron runtime. So it runs here in happy-dom against the
// real projects-pane view, the openNewThread controller path, and the panels
// controller that drives #pane-files. The active right-panel tab is `is-active`
// purely from `rightPanelMode`, so that's asserted at the store level rather
// than mounting the tab strip. Guards the same regression: creating a new
// thread must not close the side panel.

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
  it('adds a selected New Thread row while the side panel stays open in explorer mode', () => {
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
    const pane = document.createElement('div')
    pane.id = 'pane-files'
    document.body.append(projectsHost, pane)
    mountProjectsPane(projectsHost, store, apiStub)

    const chatRows = (): NodeListOf<Element> => document.querySelectorAll('.chats-list .chat-row')

    // One seeded thread; the panel starts closed.
    syncFilesPaneDom(store)
    assert.equal(chatRows().length, 1)
    assert.equal(pane.hidden, true)

    // Open the side panel (explorer) — mirrors clicking the titlebar toggle.
    toggleRightPanel(store, 'explorer')
    syncFilesPaneDom(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(pane.hidden, false)

    // Create a new thread from the expanded project row.
    document.querySelector<HTMLButtonElement>('.project-new-thread-btn')!.click()

    // A fresh blank thread is created, selected, and rendered at the top. Assert
    // the store + the selected row rather than the raw row count: the sidebar
    // paginates rows (visibleThreadCounts), so row-count is draft-prompt's
    // concern, not this regression's — here we only care that the new thread
    // exists and is the active, rendered selection.
    assert.equal(store.getState().threads.length, 2)
    assert.equal(
      document.querySelector('.chat-row.selected .chat-title')?.textContent,
      'New Thread',
    )

    // The side panel stays open in the same mode on the new thread.
    syncFilesPaneDom(store)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(pane.hidden, false)
  })
})
