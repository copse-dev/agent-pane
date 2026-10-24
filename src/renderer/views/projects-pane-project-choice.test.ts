import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { __resetPersistenceForTest } from '../controller/persistence.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { mountTitlebar } from './titlebar.ts'

function thread(id: string, populated = false): Thread {
  return {
    id,
    title: populated ? id : 'New Thread',
    status: 'idle',
    messages: populated
      ? [
          {
            id: id + '-msg',
            role: 'user',
            content: 'Existing conversation',
            toolCalls: [],
            createdAt: 1,
          },
        ]
      : [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function button(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector)
  assert.ok(element, selector)
  return element
}

function choose(label: string): void {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
    (element) => element.querySelector('.context-menu-item-label')?.textContent === label,
  )
  assert.ok(item, 'menu choice ' + label)
  item.click()
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), 'navigation settles')
}

const disposers: Array<() => void> = []
const originalResizeObserver = globalThis.ResizeObserver
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  dismissContextMenu()
  resetProjectSwitchStateForTest()
  __resetPersistenceForTest()
  document.body.replaceChildren()
  globalThis.ResizeObserver = originalResizeObserver
})

function mount(populated = false): { store: AppStore; api: ApiClient } {
  resetProjectSwitchStateForTest()
  __resetPersistenceForTest()
  const store = createStore({
    projects: [
      { id: 'a', name: 'Alpha', path: '/a' },
      { id: 'b', name: 'Beta', path: '/b' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    sidebarThreadGroup: 'status',
    threads: [thread('a-thread', populated)],
    activeThreadId: 'a-thread',
  })
  const api = createFakeApi()
  api.workspace.set = async (path): Promise<string> => path
  api.threads.loadProject = async (id): Promise<Thread[]> => [thread(id + '-existing', true)]
  const titlebar = document.createElement('div')
  const sidebar = document.createElement('div')
  document.body.append(titlebar, sidebar)
  disposers.push(mountTitlebar(titlebar, store, api), mountProjectsPane(sidebar, store, api))
  return { store, api }
}

describe('sidebar project choice for new threads', () => {
  it('uses the selected project for an already-open new thread, even with existing conversations', async () => {
    const { store } = mount()
    button('.projects-filter-btn').click()
    choose('Beta')
    await until(
      () =>
        store.getState().activeProjectId === 'b' && getActiveThread(store)?.messages.length === 0,
    )
    assert.equal(store.getState().sidebarProjectFilterId, 'b')
    assert.equal(getActiveThread(store)?.title, 'New Thread')
    assert.ok(store.getState().threads.some((item) => item.id === 'b-existing'))
    assert.equal(button('.workspace-name').textContent, 'Beta')
    assert.equal(document.querySelector('.projects-filter-label')?.textContent, 'Beta')
  })

  it('filters an existing conversation without moving it, then creates in the chosen project', async () => {
    const { store } = mount(true)
    button('.projects-filter-btn').click()
    choose('Beta')
    assert.equal(store.getState().activeProjectId, 'a')
    assert.equal(store.getState().activeThreadId, 'a-thread')
    assert.equal(button('.workspace-name').disabled, true)
    button('.projects-add-btn').click()
    choose('New thread')
    await until(
      () =>
        store.getState().activeProjectId === 'b' && getActiveThread(store)?.messages.length === 0,
    )
    assert.notEqual(store.getState().activeThreadId, 'b-existing')
  })

  it('lets the top-bar picker override the project and retains it for All projects', async () => {
    const { store } = mount()
    const picker = button('.workspace-name')
    assert.equal(picker.disabled, false)
    picker.click()
    assert.equal(document.activeElement?.textContent, 'Alpha')
    choose('Beta')
    await until(
      () =>
        store.getState().activeProjectId === 'b' && getActiveThread(store)?.messages.length === 0,
    )
    button('.projects-filter-btn').click()
    choose('All projects')
    assert.equal(store.getState().sidebarProjectFilterId, null)
    button('.projects-add-btn').click()
    choose('New thread')
    assert.equal(store.getState().activeProjectId, 'b')
  })

  it('preserves an unsent draft when selecting the current project', () => {
    const { store } = mount()
    store.setState({ threads: [{ ...thread('a-thread'), draftPrompt: 'Keep this draft' }] })
    button('.projects-filter-btn').click()
    choose('Alpha')
    assert.equal(store.getState().activeThreadId, 'a-thread')
    assert.equal(getActiveThread(store)?.draftPrompt, 'Keep this draft')
  })

  it('flushes the outgoing draft before switching projects', async () => {
    const { store, api } = mount()
    const saved: Thread[] = []
    api.threads.create = async (_projectId, item): Promise<void> => {
      saved.push(item)
    }
    disposers.push(
      store.on('composer_draft_flush', () => {
        store.setState({ threads: [{ ...thread('a-thread'), draftPrompt: 'Unsent Alpha work' }] })
      }),
    )
    button('.projects-filter-btn').click()
    choose('Beta')
    await until(
      () =>
        store.getState().activeProjectId === 'b' && getActiveThread(store)?.messages.length === 0,
    )
    assert.ok(
      saved.some((item) => item.id === 'a-thread' && item.draftPrompt === 'Unsent Alpha work'),
    )
  })

  for (const selection of ['All projects', 'Beta']) {
    it(`keeps a populated conversation when ${selection} cancels a pending project switch`, async () => {
      const { store, api } = mount(true)
      const workspaceSets: string[] = []
      let release: ((path: string) => void) | undefined
      api.workspace.set = (path): Promise<string> => {
        workspaceSets.push(path)
        if (path !== '/b') return Promise.resolve(path)
        return new Promise<string>((resolve) => {
          release = resolve
        })
      }
      button('.project-entry[data-project-id="b"] .project-row').click()
      await until(() => release !== undefined)
      button('.projects-filter-btn').click()
      choose(selection)
      assert.ok(release)
      release('/b')
      await until(() => workspaceSets.at(-1) === '/a')
      assert.equal(store.getState().activeProjectId, 'a')
      assert.equal(store.getState().activeThreadId, 'a-thread')
      assert.equal(getActiveThread(store)?.messages[0]?.content, 'Existing conversation')
      assert.equal(store.getState().workspaceRoot, '/a')
    })
  }

  it('cancels a pending project choice when All projects is chosen', async () => {
    const { store, api } = mount()
    let release: ((path: string) => void) | undefined
    api.workspace.set = (): Promise<string> =>
      new Promise<string>((resolve) => {
        release = resolve
      })
    button('.projects-filter-btn').click()
    choose('Beta')
    await until(() => release !== undefined)
    button('.projects-filter-btn').click()
    choose('All projects')
    api.workspace.set = async (path): Promise<string> => path
    assert.ok(release)
    release('/b')
    await until(() => store.getState().expandedProjectId === 'a')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.equal(store.getState().activeProjectId, 'a')
    assert.equal(store.getState().activeThreadId, 'a-thread')
  })
})
