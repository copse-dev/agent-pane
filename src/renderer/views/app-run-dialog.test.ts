import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createAppRunPanel } from './app-run-dialog.ts'
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
})
