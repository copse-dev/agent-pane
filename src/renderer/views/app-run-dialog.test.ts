import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createAppRunPanel, openAppRunDialog } from './app-run-dialog.ts'
import { createStore } from '@shared/store/store.ts'
import { setThreadTitle } from '@shared/store/thread-helpers.ts'
import { makeThread } from '../thread-fixture.test-support.ts'
import type { AppRunDiscovery, AppRunOperation, AppRunSelection } from '@shared/types/app-run.ts'
const owner = { projectId: 'project', threadId: 'thread' }
const data: AppRunDiscovery = {
  apps: [
    {
      id: 'android:app',
      platform: 'android',
      name: 'Sample',
      location: 'app',
      variants: ['Debug', 'DemoDebug'],
    },
  ],
  devices: [],
  issues: [],
  preferred: null,
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => {
    fn()
  })
  document.body.replaceChildren()
})
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
describe('Run app picker', () => {
  it('loads app/device choices without enrollment and starts one explicit workflow', async () => {
    const api = createFakeApi()
    let submitted: AppRunSelection | undefined
    api.appRun.discover = async (): Promise<AppRunDiscovery> => data
    api.appRun.devices = async (): Promise<AppRunDiscovery['devices']> => [
      { id: 'phone', platform: 'android', name: 'Pixel', runtime: 'Android', state: 'stopped' },
    ]
    api.appRun.execute = async (context, selection, action): Promise<AppRunOperation> => {
      assert.deepEqual(context, owner)
      assert.equal(action, 'run')
      submitted = selection
      return {
        id: 'op',
        owner,
        action,
        stage: 'building',
        appName: 'Sample',
        deviceName: 'Pixel',
        createdAt: 1,
        updatedAt: 1,
        logs: 'Compiling',
        error: null,
        desktopId: null,
        appSessionId: null,
      }
    }
    const panel = createAppRunPanel(api, owner)
    cleanup.push(panel.dispose)
    document.body.append(panel.element)
    await settle()
    const run = panel.element.querySelector<HTMLButtonElement>('.app-run-run')
    assert.ok(run)
    assert.equal(run.disabled, false)
    assert.equal(panel.element.querySelector('details')?.open, false)
    run.click()
    await settle()
    assert.equal(submitted?.variant, 'Debug')
    assert.equal(submitted.deviceId, 'phone')
    assert.equal(submitted.provisioningUpdates, false)
    assert.equal(panel.element.querySelector('.app-run-stage')?.textContent, 'Building')
    assert.equal(run.disabled, true)
  })
  it('keeps failed launch details visible and does not present success', async () => {
    const api = createFakeApi()
    let launched = false
    api.appRun.discover = async (): Promise<AppRunDiscovery> => data
    api.appRun.devices = async (): Promise<AppRunDiscovery['devices']> => []
    const operation: AppRunOperation = {
      id: 'op',
      owner,
      action: 'run',
      stage: 'failed',
      appName: 'Sample',
      deviceName: 'Pixel',
      createdAt: 1,
      updatedAt: 2,
      logs: 'Install failed',
      error: 'Device disconnected',
      desktopId: null,
      appSessionId: null,
    }
    api.appRun.operations = async (): Promise<AppRunOperation[]> => [operation]
    const panel = createAppRunPanel(api, owner, () => {
      launched = true
    })
    cleanup.push(panel.dispose)
    document.body.append(panel.element)
    await settle()
    assert.equal(panel.element.querySelector('.app-run-stage')?.textContent, 'Failed')
    assert.equal(panel.element.querySelector('.app-run-error')?.textContent, 'Device disconnected')
    assert.equal(launched, false)
    assert.equal(panel.element.querySelector<HTMLButtonElement>('.app-run-run')?.disabled, true)
  })
  it('closes an open dialog when setState alone switches the workspace', async () => {
    const api = createFakeApi()
    api.appRun.discover = async (): Promise<AppRunDiscovery> => data
    api.appRun.devices = async (): Promise<AppRunDiscovery['devices']> => []
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project',
      projects: [
        { id: 'project', name: 'Project', path: '/repo' },
        { id: 'other', name: 'Other', path: '/other' },
      ],
    })
    openAppRunDialog(store, api)
    cleanup.push(() => {
      document.querySelector<HTMLDialogElement>('#app-run-dialog')?.close()
    })
    await settle()
    assert.ok(document.querySelector('#app-run-dialog[open]'), 'the dialog opens')

    // No store event: the selection alone must close the dialog.
    store.setState({ activeProjectId: 'other', workspaceRoot: '/other' })
    await settle()
    assert.equal(
      document.querySelectorAll('#app-run-dialog').length,
      0,
      'the workspace switch closes the dialog',
    )
  })
})

describe('Run app dialog thread scope', () => {
  it('stays open across thread metadata updates and closes on a bare selection change', () => {
    const store = createStore({
      activeProjectId: 'project',
      activeThreadId: 'thread',
      threads: [makeThread({ id: 'thread' }), makeThread({ id: 'other' })],
    })
    const api = createFakeApi()
    api.appRun.discover = async (): Promise<AppRunDiscovery> => data
    openAppRunDialog(store, api)
    const dialog = (): HTMLDialogElement | null =>
      document.querySelector<HTMLDialogElement>('#app-run-dialog')
    assert.equal(dialog()?.open, true)

    setThreadTitle(store, 'thread', 'Renamed')
    setThreadTitle(store, 'other', 'Renamed too')
    store.emit('threads_changed')
    assert.equal(dialog()?.open, true, 'thread metadata does not close the dialog')

    // No event: the selection alone closes a dialog scoped to the old thread.
    store.setState({ activeThreadId: 'other' })
    assert.notEqual(dialog()?.open, true)
  })
})
