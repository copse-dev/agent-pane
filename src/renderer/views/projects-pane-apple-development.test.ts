import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { PluginsListResult } from '@shared/types/plugins.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountProjectsPane } from './projects-pane.ts'

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`timed out waiting for ${what}`)
}

function twoProjectStore(): AppStore {
  return createStore({
    projects: [
      { id: 'a', path: '/a', name: 'Alpha' },
      { id: 'b', path: '/b', name: 'Beta' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
  })
}

function runAppApi(): ApiClient {
  const api = createFakeApi()
  api.plugins.list = (): Promise<PluginsListResult> => Promise.resolve({ plugins: [] })
  api.appRun.detect = (): Promise<boolean> => Promise.resolve(true)
  return api
}

async function chooseRunAppFor(host: HTMLElement, projectId: string): Promise<void> {
  host
    .querySelector<HTMLButtonElement>(
      `.project-entry[data-project-id="${projectId}"] .project-menu-btn`,
    )
    ?.click()
  await waitFor(() => document.querySelector('.context-menu-item') !== null, 'the project menu')
  const runApp = Array.from(document.querySelectorAll<HTMLElement>('.context-menu-item')).find(
    (item) => item.textContent === 'Run app…',
  )
  assert.ok(runApp, 'the menu offers Run app')
  runApp.click()
}

afterEach(() => {
  // Close through the dialog's own button so its panel stops polling.
  document.querySelector<HTMLButtonElement>('#app-run-dialog [aria-label="Close Run app"]')?.click()
  dismissContextMenu()
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('project row Run app menu', () => {
  it('offers setup only when the lightweight project probe finds Apple metadata', async () => {
    const store = createStore({
      projects: [{ id: 'apple', path: '/workspace', name: 'DemoApp' }],
      activeProjectId: 'apple',
      activeThreadId: 'generated-app-thread',
      expandedProjectId: 'apple',
      workspaceRoot: '/workspace',
    })
    const api = createFakeApi()
    api.plugins.list = (): Promise<PluginsListResult> => Promise.resolve({ plugins: [] })
    api.appRun.detect = (owner): Promise<boolean> => {
      assert.deepEqual(owner, { projectId: 'apple', threadId: 'generated-app-thread' })
      return Promise.resolve(true)
    }
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)

    host.querySelector<HTMLButtonElement>('.project-menu-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const labels = Array.from(document.querySelectorAll('.context-menu-item')).map(
      (item) => item.textContent,
    )
    assert.ok(labels.includes('Run app…'))
    assert.ok(labels.includes('Remove from sidebar'))
  })
  it('opens Run app for another project once the switch to it lands', async () => {
    const store = twoProjectStore()
    const api = runAppApi()
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)

    await chooseRunAppFor(host, 'b')
    assert.equal(document.querySelector('#app-run-dialog[open]'), null, 'not before the switch')

    await waitFor(() => document.querySelector('#app-run-dialog[open]') !== null, 'the dialog')
    assert.equal(store.getState().activeProjectId, 'b')
    assert.equal(store.getState().workspaceRoot, '/b')
  })

  it('does not open Run app when the switch to that project fails', async () => {
    const store = twoProjectStore()
    const api = runAppApi()
    const opened: string[] = []
    api.workspace.set = (root: string): Promise<string> => {
      opened.push(root)
      return root === '/b' ? Promise.reject(new Error('ENOENT')) : Promise.resolve(root)
    }
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)

    await chooseRunAppFor(host, 'b')
    await waitFor(
      () => store.getState().projects.find((project) => project.id === 'b')?.missing === true,
      'the failed project to be quarantined',
    )
    // Let the rejected switch settle through its waiter and the menu handler.
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.ok(opened.includes('/b'), 'the switch did try to open the project')
    assert.equal(store.getState().activeProjectId, 'a')
    assert.equal(document.querySelector('#app-run-dialog'), null)
  })
})
