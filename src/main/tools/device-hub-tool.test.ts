import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { storageDelete, storageSet } from '../services/storage/storage.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { deviceHubService } from '../services/apple-development/device-hub.ts'
import { deviceHubTool } from './device-hub-tool.ts'

const context: ThreadExecutionContext = {
  projectId: 'agent-project',
  threadId: 'thread',
  projectRoot: '/project',
  root: '/project',
  checkoutMode: 'shared',
  branch: null,
}
const storeKey = 'plugin.copse.apple-development.state'

afterEach(() => {
  mock.restoreAll()
  setDefaultPluginRegistry(null)
  for (const key of [storeKey, 'activeProjectId', 'projects']) storageDelete(key)
})

describe('Device Hub tool contract', () => {
  it('requires an explicit device for every device operation', () => {
    for (const action of ['apps', 'launch', 'screenshot', 'show', 'input']) {
      assert.equal(deviceHubTool.parameters.safeParse({ action }).success, false)
    }
    assert.equal(deviceHubTool.parameters.safeParse({ action: 'open' }).success, true)
    assert.equal(
      deviceHubTool.parameters.safeParse({
        action: 'input',
        device_id: 'abc',
        input: { type: 'tap', x: 2, y: 0 },
      }).success,
      false,
    )
    assert.equal(
      deviceHubTool.parameters.safeParse({
        action: 'launch',
        device_id: 'abc',
        bundle_id: '--console',
      }).success,
      false,
    )
  })

  it('rejects execution without an enrolled Apple project before touching devices', async () => {
    await assert.rejects(
      async () => deviceHubTool.execute({ action: 'list' }, new AbortController().signal),
      /enroll a local macOS project/,
    )
  })
})

describe('Device Hub project authority', () => {
  it('does not borrow enrollment from the project selected in the UI', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.enable(APPLE_DEVELOPMENT_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    storageSet('activeProjectId', 'selected-project')
    storageSet(storeKey, {
      version: 1,
      projects: { 'selected-project': { enrolled: true, threads: {} } },
    })
    const list = mock.method(deviceHubService, 'list', async () => [])
    await runWithThreadExecutionContext(context, async () => {
      await assert.rejects(
        async () => deviceHubTool.execute({ action: 'list' }, new AbortController().signal),
        /enroll a local macOS project/,
      )
    })
    assert.equal(list.mock.callCount(), 0)
  })

  it(
    'uses the enrolled task project and refuses physical devices for simulator input',
    { skip: process.platform !== 'darwin' },
    async () => {
      const plugins = createFirstPartyPluginRegistry()
      plugins.enable(APPLE_DEVELOPMENT_PLUGIN_ID)
      setDefaultPluginRegistry(plugins)
      storageSet('activeProjectId', 'unrelated-project')
      storageSet(storeKey, {
        version: 1,
        projects: { [context.projectId]: { enrolled: true, threads: {} } },
      })
      mock.method(deviceHubService, 'list', async () => [])
      mock.method(deviceHubService, 'device', async () => ({
        id: 'physical',
        udid: 'physical',
        name: 'Phone',
        platform: 'iOS',
        osVersion: '27',
        kind: 'physical',
        connection: 'connected',
        bootState: 'booted',
        screenshot: true,
        input: false,
      }))
      await runWithThreadExecutionContext(context, async () => {
        const signal = new AbortController().signal
        assert.equal(await deviceHubTool.execute({ action: 'list' }, signal), '[]')
        await assert.rejects(
          async () =>
            deviceHubTool.execute(
              { action: 'input', device_id: 'physical', input: { type: 'tap', x: 0.5, y: 0.5 } },
              signal,
            ),
          /Physical-device input/,
        )
        storageSet('projects', [{ id: context.projectId, path: '/project', sshHost: 'remote' }])
        await assert.rejects(
          async () => deviceHubTool.execute({ action: 'list' }, signal),
          /local macOS project/,
        )
      })
    },
  )
})
